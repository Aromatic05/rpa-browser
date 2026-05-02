import path from 'node:path';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createWorkspaceRegistry } from './runtime/workspace_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import {
    createRecordingState,
    cleanupRecording,
    ensureRecorder,
    setRecorderEventSink,
    getWorkspaceActiveRecordingToken,
    attachTabToRecordingManifest,
} from './record/recording';
import { setRecorderRuntimeEnabled } from './record/recorder';
import { loadRecordingStateFromFile, startRecordingStateAutoSave } from './record/persistence';
import { executeAction, type ActionContext } from './actions/execute';
import { failedAction, isFailedAction, type Action } from './actions/action_protocol';
import { ERROR_CODES } from './actions/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, getLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { ACTION_TYPES } from './actions/action_types';
import { createActionDispatcher } from './actions/dispatcher';
import { startActionWsClient } from './actions/ws_client';
import { createControlServer, registerControlShutdown, setControlActionDispatcher } from './control';
import { ensureWorkflowOnFs } from './workflow';

const TAB_NAME_KEY = '__rpa_tab_name';
const WS_PORT = Number(process.env.RPA_WS_PORT || 17333);
const TAB_PING_TIMEOUT_MS = 45000;
const TAB_PING_WATCHDOG_INTERVAL_MS = 5000;
const REPLAY_OPTIONS = {
    clickDelayMs: 300,
    stepDelayMs: 900,
    scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 },
};
const NAV_DEDUPE_WINDOW_MS = 1200;
const WS_TAP_ENABLED = process.env.RPA_WS_TAP === '1';

const actionLog = getLogger('action');
const log = (...args: unknown[]) => { actionLog.info('[RPA:agent]', ...args); };
const logWarning = (...args: unknown[]) => { actionLog.warning('[RPA:agent]', ...args); };
const logError = (...args: unknown[]) => { actionLog.error('[RPA:agent]', ...args); };
const logTabReportDebug = (stage: string, data: Record<string, unknown>) =>
    { actionLog.debug('[RPA:tab.report]', { ts: Date.now(), stage, ...data }); };
const wsTap = (stage: string, data: Record<string, unknown>) => {
    if (!WS_TAP_ENABLED) {return;}
    actionLog.warning('[RPA:ws.tap]', { ts: Date.now(), stage, ...data });
};
let broadcast: (action: Action) => void = () => undefined;

const paths = resolvePaths();
const recordingState = createRecordingState();
const workspaceRegistry = createWorkspaceRegistry();
const recordingStatePath = path.resolve(paths.userDataDir, 'recordings.state.json');
await loadRecordingStateFromFile(recordingState, recordingStatePath);
const recordingPersistence = startRecordingStateAutoSave(recordingState, recordingStatePath, {
    intervalMs: 1500,
    onError: (error) => { actionLog.error('[RPA:agent]', 'recording persistence error', String(error)); },
});

const contextManager = createContextManager({
    extensionPaths: paths.extensionPaths,
    userDataDir: paths.userDataDir,
    onPage: (page) => {
        void pageRegistry.bindPage(page);
    },
});

const config = getRunnerConfig();
initLogger(config);
const actionLogger = getLogger('action');
const traceSinks = config.observability.traceFileEnabled
    ? [new FileSink(resolveLogPath(config.observability.traceFilePath))]
    : [];
const runnerPluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
await runnerPluginHost.load();
if (process.env.NODE_ENV !== 'production') {
    runnerPluginHost.watchDev(path.resolve(process.cwd(), '.runner-dist'));
}

const REPORT_STATE_SYNC_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.WORKSPACE_RESTORE,
    ACTION_TYPES.TAB_CREATE,
    ACTION_TYPES.TAB_OPENED,
    ACTION_TYPES.TAB_REPORTED,
    ACTION_TYPES.TAB_CLOSED,
    ACTION_TYPES.TAB_REASSIGN,
]);
const staleNotifiedTabs = new Set<string>();
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null;

const getStringField = (value: UnknownRecord, key: string): string | null =>
    typeof value[key] === 'string' ? value[key] : null;

const broadcastStateSync = (reason: string, data?: Record<string, unknown>) => {
    broadcast({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_SYNC,
        payload: { reason, ...(data || {}) },
        at: Date.now(),
    });
};

const broadcastWorkspaceList = (reason: string) => {
    const active = workspaceRegistry.getActiveWorkspace();
    const workspaces = workspaceRegistry.listWorkspaces().map((workspace) => ({
        workspaceName: workspace.name,
        activeTabName: workspace.tabRegistry.getActiveTab()?.name ?? null,
        tabCount: workspace.tabRegistry.listTabs().length,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
    }));
    broadcast({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_LIST,
        payload: {
            reason,
            workspaces,
            activeWorkspaceName: active?.name || null,
        },
        at: Date.now(),
    });
};

const findWorkspaceNameByTabName = (tabName: string): string | null => {
    for (const workspace of workspaceRegistry.listWorkspaces()) {
        if (workspace.tabRegistry.hasTab(tabName)) {
            return workspace.name;
        }
    }
    return null;
};

const resolveWorkspaceForBinding = (bindingName: string) => {
    const workspaceName = findWorkspaceNameByTabName(bindingName)
        || workspaceRegistry.getActiveWorkspace()?.name
        || 'default';
    return {
        workspaceName,
        workspace: workspaceRegistry.createWorkspace(workspaceName, ensureWorkflowOnFs(workspaceName)),
    };
};

const pageRegistry = createPageRegistry({
    tabNameKey: TAB_NAME_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, bindingName) => {
        const { workspaceName, workspace } = resolveWorkspaceForBinding(bindingName);
        if (!workspace.tabRegistry.hasTab(bindingName)) {
            workspace.tabRegistry.createTab({ tabName: bindingName, page, url: page.url() });
        } else {
            workspace.tabRegistry.bindPage(bindingName, page);
        }
        workspace.tabRegistry.setActiveTab(bindingName);
        runtimeRegistry.bindPage({ workspaceName, tabName: bindingName, page });
        const activeRecordingToken = getWorkspaceActiveRecordingToken(recordingState, workspaceName);
        if (activeRecordingToken) {
            attachTabToRecordingManifest(recordingState, activeRecordingToken, bindingName, {
                tabRef: bindingName,
                url: page.url(),
            });
            void ensureRecorder(recordingState, page, bindingName, NAV_DEDUPE_WINDOW_MS);
            void setRecorderRuntimeEnabled(page, true);
        }
        broadcast({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.TAB_BOUND,
            payload: { workspaceName, tabName: bindingName, url: page.url() },
            workspaceName,
            at: Date.now(),
        });
    },
    onBindingClosed: (tabName) => { cleanupRecording(recordingState, tabName); },
});

const runnerScope = createRunnerScopeRegistry(2);
const runtimeRegistry: ReturnType<typeof createRuntimeRegistry> = createRuntimeRegistry({
    workspaceRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled ? createLoggingHooks() : createNoopHooks(),
    pluginHost: runnerPluginHost,
});
const runStepsDeps = {
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
};
setRunStepsDeps(runStepsDeps);
const actionDispatcher = createActionDispatcher({
    pageRegistry,
    workspaceRegistry,
    recordingState,
    log: actionLogger,
    replayOptions: REPLAY_OPTIONS,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    emit: broadcast,
    runStepsDeps,
});
setControlActionDispatcher(actionDispatcher);
const controlServer = createControlServer({ deps: runStepsDeps });
registerControlShutdown(controlServer, log);

const createActionContext = (workspaceName: string, tabName?: string): ActionContext => {
    const workspace = workspaceRegistry.getWorkspace(workspaceName);
    const resolveTab = (name?: string) => {
        if (!workspace) {throw new Error('workspace not found');}
        return workspace.tabRegistry.resolveTab(name ?? tabName);
    };
    const resolvePage = (name?: string) => {
        const tab = resolveTab(name);
        if (!tab.page) {throw new Error('page not bound');}
        return tab.page;
    };
    const ctx: ActionContext = {
        workspaceRegistry,
        workspace,
        resolveTab,
        resolvePage,
        pageRegistry,
        log: actionLogger,
        recordingState,
        replayOptions: REPLAY_OPTIONS,
        navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        emit: broadcast,
        runStepsDeps,
        execute: undefined,
    };
    ctx.execute = (innerAction: Action) => executeAction(ctx, innerAction);
    return ctx;
};

const handleAction = async (action: Action) => {
    const payload = isRecord(action.payload) ? action.payload : null;
    const urlHint = payload && typeof payload.url === 'string' ? payload.url : undefined;
    log('action.inbound', {
        id: action.id,
        type: action.type,
        workspaceName: action.workspaceName || null,
        urlHint: urlHint || null,
    });
    if (action.type === ACTION_TYPES.TAB_REPORTED) {
        logTabReportDebug('agent.inbound', {
            id: action.id,
            workspaceName: action.workspaceName || null,
            urlHint: urlHint || null,
        });
    }

    try {
        if (action.workspaceName) {
            return await runnerScope.run(action.workspaceName, async () => await actionDispatcher.dispatch(action));
        }
        return await actionDispatcher.dispatch(action);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logWarning('action.dispatch.error', {
            id: action.id,
            type: action.type,
            message,
            workspaceName: action.workspaceName || null,
        });
        return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, message);
    }
};

const isMutatingAction = (type: string) =>
    type === ACTION_TYPES.WORKSPACE_CREATE ||
    type === ACTION_TYPES.WORKSPACE_RESTORE ||
    type === ACTION_TYPES.WORKSPACE_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CREATE ||
    type === ACTION_TYPES.TAB_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CLOSE ||
    type === ACTION_TYPES.TAB_CLOSED ||
    type === ACTION_TYPES.TAB_REASSIGN;

const projectActionResult = (action: Action, response: Action): Action[] => {
    const projected: Action[] = [];
    if (!isFailedAction(response) && isMutatingAction(action.type)) {
        const data = isRecord(response.payload) ? response.payload : null;
        const workspaceName = data ? getStringField(data, 'workspaceName') : null;
        const tabName = data ? getStringField(data, 'tabName') : null;
        projected.push({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_CHANGED,
            payload: { workspaceName: workspaceName, tabName: tabName, sourceType: action.type },
            workspaceName: workspaceName || undefined,
            at: Date.now(),
        });
    }
    if (!isFailedAction(response) && REPORT_STATE_SYNC_ACTIONS.has(action.type)) {
        const data = isRecord(response.payload) ? response.payload : null;
        const workspaceName = (data ? getStringField(data, 'workspaceName') : null) ?? action.workspaceName ?? null;
        const tabName = data ? getStringField(data, 'tabName') : null;
        if (action.type === ACTION_TYPES.TAB_REPORTED) {
            logTabReportDebug('agent.emit.state_sync', {
                id: action.id,
                reason: `report:${action.type}`,
                workspaceName,
                tabName,
            });
        }
        projected.push({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_SYNC,
            payload: { reason: `report:${action.type}`, workspaceName, tabName },
            at: Date.now(),
        });
        const active = workspaceRegistry.getActiveWorkspace();
        const workspaces = workspaceRegistry.listWorkspaces().map((workspace) => ({
            workspaceName: workspace.name,
            activeTabName: workspace.tabRegistry.getActiveTab()?.name ?? null,
            tabCount: workspace.tabRegistry.listTabs().length,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
        }));
        projected.push({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_LIST,
            payload: {
                reason: `report:${action.type}`,
                workspaces,
                activeWorkspaceName: active?.name || null,
            },
            at: Date.now(),
        });
    }
    return projected;
};

const actionWsClient = startActionWsClient({
    port: WS_PORT,
    host: '127.0.0.1',
    dispatchAction: async (action) => {
        try {
            return await handleAction(action);
        } finally {
            void recordingPersistence.flush();
        }
    },
    projectActionResult,
    onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logError('action.dispatch.failed', { message });
    },
    onListening: (url) => { log(`WS listening on ${url}`); },
    wsTap,
});
broadcast = actionWsClient.broadcastAction;

/**
 * ========================= Listener Group A: Recorder Event Sink =========================
 * 触发源：
 * - record/recorder.ts 注入到页面的 payload 通过 exposeBinding 回传原始录制事件
 *
 * 职责：
 * 1) 在进入 action 执行前，先做“是否仍在录制”的硬门禁；
 * 2) 将原始 recorder event 包装为统一 Action(record.event) 广播给观察端；
 * 3) 同步交给 executeAction 进入录制入库链路（recordEvent/recordStep）。
 *
 * 关键约束：
 * - 无活跃录制会话时直接丢弃（不广播、不执行），避免 record.stop 后仍出现录制流量；
 * - 若仅存在一个活跃录制 token，允许将事件归并到该唯一 token（跨 tab 人工录制场景）。
 */
setRecorderEventSink(async (event, page, tabName) => {
    let effectiveTabName = tabName;
    if (!recordingState.recordingEnabled.has(effectiveTabName)) {
        if (recordingState.recordingEnabled.size === 1) {
            effectiveTabName = Array.from(recordingState.recordingEnabled)[0];
        } else {
            wsTap('agent.record_event.drop', {
                reason: 'recording_not_enabled',
                sourceTabName: tabName,
                activeRecordingCount: recordingState.recordingEnabled.size,
            });
            return;
        }
    }

    const workspaceName = findWorkspaceNameByTabName(effectiveTabName) || undefined;
    const action: Action = {
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.RECORD_EVENT,
        workspaceName,
        payload: event,
        at: event.ts || Date.now(),
    };
    broadcast(action);
    if (!workspaceName) {return;}
    const response = await executeAction(createActionContext(workspaceName, effectiveTabName), action);
    if (isFailedAction(response)) {
        logWarning('record.event.ingest.failed', { tabName: effectiveTabName, sourceTabName: tabName, error: response.payload });
    }
});

/**
 * ========================= Listener Group C: Tab Ping Watchdog Timer =========================
 * 触发源：
 * - 固定周期定时器（TAB_PING_WATCHDOG_INTERVAL_MS）
 *
 * 职责：
 * - 检测超时未上报 ping 的 tabName；
 * - 首次发现时广播 ping-timeout 状态同步；
 * - 触发 pageRegistry.closePage 回收失活页资源。
 *
 * 说明：
 * - staleNotifiedTabs 用于抑制重复通知，避免同一 tab 反复刷屏。
 */
setInterval(() => {
    const staleTabs = pageRegistry.listStaleBindings(TAB_PING_TIMEOUT_MS, Date.now());
    for (const stale of staleTabs) {
        if (staleNotifiedTabs.has(stale.bindingName)) {continue;}
        staleNotifiedTabs.add(stale.bindingName);
        const workspaceName = findWorkspaceNameByTabName(stale.bindingName);
        broadcastStateSync('ping-timeout', {
            workspaceName,
            tabName: stale.bindingName,
            lastSeenAt: stale.lastSeenAt,
        });
        void pageRegistry.closePage(stale.bindingName);
    }
}, TAB_PING_WATCHDOG_INTERVAL_MS);

(async () => {
    await contextManager.getContext();
    await controlServer.start();
    if (workspaceRegistry.listWorkspaces().length === 0) {
        const created = workspaceRegistry.createWorkspace('default', ensureWorkflowOnFs('default'));
        assert.ok(created.name, 'bootstrap workspaceName missing');
        log('workspace.bootstrap.created', { workspaceName: created.name });
    }
    broadcastWorkspaceList('bootstrap');
    log(`Control RPC listening on ${controlServer.endpoint}`);
    log('Playwright Chromium launched with extension.');
})().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Fatal startup error:', message);
    throw error;
});
