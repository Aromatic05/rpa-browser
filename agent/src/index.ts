import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Page } from 'playwright';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder, setRecorderEventSink } from './record/recording';
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
import { ACTION_TYPES, isRequestActionType } from './actions/action_types';
import { createActionDispatcher } from './actions/dispatcher';
import { createControlServer, registerControlShutdown, setControlActionDispatcher } from './control';

const TAB_TOKEN_KEY = '__rpa_tab_token';
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
const summarizeActionEnvelope = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object') {
        return { kind: typeof raw, isObject: false };
    }
    const rec = raw as Record<string, unknown>;
    const payload = rec.payload;
    return {
        v: rec.v,
        id: typeof rec.id === 'string' ? rec.id : undefined,
        replyTo: typeof rec.replyTo === 'string' ? rec.replyTo : undefined,
        type: typeof rec.type === 'string' ? rec.type : undefined,
        workspaceName: typeof rec.workspaceName === 'string' ? rec.workspaceName : undefined,
        payloadType: Array.isArray(payload) ? 'array' : typeof payload,
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload as Record<string, unknown>).slice(0, 12) : [],
    };
};

const paths = resolvePaths();
const recordingState = createRecordingState();
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

const wsClients = new Set<WebSocket>();
const broadcast = (action: Action) => {
    wsTap('agent.broadcast', summarizeActionEnvelope(action));
    const payload = JSON.stringify(action);
    wsClients.forEach((client) => {
        try {
            if (client.readyState === client.OPEN) {client.send(payload);}
        } catch {
            // ignore
        }
    });
};

const REPORT_STATE_SYNC_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.WORKSPACE_RESTORE,
    ACTION_TYPES.TAB_CREATE,
    ACTION_TYPES.TAB_OPENED,
    ACTION_TYPES.TAB_REPORTED,
    ACTION_TYPES.TAB_CLOSED,
    ACTION_TYPES.TAB_REASSIGN,
]);
const staleNotifiedTokens = new Set<string>();
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
    const active = pageRegistry.getActiveWorkspace();
    const workspaces = pageRegistry.listWorkspaces().map((workspace) => ({
        workspaceName: workspace.workspaceId,
        activeTabName: workspace.activeTabId,
        tabCount: workspace.tabCount,
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
            activeWorkspaceName: active?.workspaceId || null,
        },
        at: Date.now(),
    });
};

const pageRegistry = createPageRegistry({
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
        }
        try {
            runtimeRegistry.bindPage(page, token);
        } catch {
            // runtime trace binding is best-effort during early token/workspace races
        }
        try {
            const scope = pageRegistry.resolveScopeFromToken(token);
            broadcast({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_BOUND,
                payload: { workspaceName: scope.workspaceId, tabName: scope.tabId, url: page.url() },
                workspaceName: scope.workspaceId,
                at: Date.now(),
            });
        } catch {
            // ignore
        }
    },
    onTokenClosed: (token) => { cleanupRecording(recordingState, token); },
});

const runnerScope = createRunnerScopeRegistry(2);
const runtimeRegistry: ReturnType<typeof createRuntimeRegistry> = createRuntimeRegistry({
    pageRegistry,
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
    runtime: runtimeRegistry,
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

const createActionContext = (page: Page, tabToken: string): ActionContext => {
    const ctx: ActionContext = {
        page,
        tabToken,
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

const parseInboundAction = (raw: unknown): Action => {
    if (!raw || typeof raw !== 'object') {
        throw new Error('invalid action: not an object');
    }
    const rec = raw as Record<string, unknown>;
    if (rec.v !== 1 || typeof rec.id !== 'string' || typeof rec.type !== 'string' || !rec.id) {
        throw new Error('invalid action: missing or invalid fields');
    }
    if ('scope' in rec || 'tabToken' in rec || 'workspaceId' in rec || 'tabId' in rec || 'tabToken' in rec) {
        throw new Error('invalid action: legacy address fields are not allowed');
    }
    if (!isRequestActionType(rec.type)) {
        throw new Error(`invalid action: unsupported type '${rec.type}'`);
    }
    return rec as Action;
};

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
setRecorderEventSink(async (event, page, tabToken) => {
    let effectiveToken = tabToken;
    if (!recordingState.recordingEnabled.has(effectiveToken)) {
        if (recordingState.recordingEnabled.size === 1) {
            effectiveToken = Array.from(recordingState.recordingEnabled)[0];
        } else {
            wsTap('agent.record_event.drop', {
                reason: 'recording_not_enabled',
                sourceTabToken: tabToken,
                activeRecordingCount: recordingState.recordingEnabled.size,
            });
            return;
        }
    }

    let workspaceName: string | undefined;
    try {
        const resolved = pageRegistry.resolveScopeFromToken(effectiveToken);
        workspaceName = resolved.workspaceId;
    } catch {}
    const action: Action = {
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.RECORD_EVENT,
        workspaceName,
        payload: event,
        at: event.ts || Date.now(),
    };
    broadcast(action);
    const response = await executeAction(createActionContext(page, effectiveToken), action);
    if (isFailedAction(response)) {
        logWarning('record.event.ingest.failed', { tabToken: effectiveToken, sourceTabToken: tabToken, error: response.payload });
    }
});

/**
 * ========================= Listener Group B: Agent WebSocket Server =========================
 * 触发源：
 * - extension background / start_extension / 其他 ws client 发来的 action 请求
 *
 * 生命周期与职责：
 * - listening: 记录启动完成；
 * - connection: 注册连接；
 * - message:
 *   1) 解析原始 JSON；
 *   2) 校验为受支持的 Action；
 *   3) 路由到 handleAction 执行；
 *   4) 回写 *.result / *.failed；
 *   5) 对状态变化类 action 追加广播 workspace.changed / workspace.sync。
 *
 * 可观测性：
 * - RPA_WS_TAP=1 时输出 inbound/raw/parsed、reply、broadcast 的结构化抓包日志。
 */
const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

wss.on('listening', () => {
    log(`WS listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.on('message', (data) => {
        let raw: unknown;
        let rawText = '';
        try {
            rawText =
                typeof data === 'string'
                    ? data
                    : Buffer.isBuffer(data)
                      ? data.toString('utf8')
                      : Array.isArray(data)
                        ? Buffer.concat(data).toString('utf8')
                        : data instanceof ArrayBuffer
                        ? Buffer.from(data).toString('utf8')
                        : '';
            wsTap('agent.inbound.raw', { bytes: rawText.length, preview: rawText.slice(0, 300) });
            raw = JSON.parse(rawText);
            wsTap('agent.inbound.parsed', summarizeActionEnvelope(raw));
        } catch {
            socket.send(
                JSON.stringify({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'action.dispatch.failed',
                    payload: { code: 'ERR_BAD_JSON', message: 'invalid json' },
                    at: Date.now(),
                } satisfies Action),
            );
            wsTap('agent.inbound.parse_failed', { bytes: rawText.length, preview: rawText.slice(0, 300) });
            return;
        }

        void (async () => {
            try {
                const action = parseInboundAction(raw);
                const response = await handleAction(action);
                if (action.type === ACTION_TYPES.TAB_REPORTED) {
                    const responsePayload = isRecord(response.payload) ? response.payload : null;
                    logTabReportDebug('agent.reply', {
                        id: action.id,
                        ok: !isFailedAction(response),
                        workspaceName: responsePayload ? getStringField(responsePayload, 'workspaceName') : null,
                        tabName: responsePayload ? getStringField(responsePayload, 'tabName') : null,
                        tabToken: responsePayload ? getStringField(responsePayload, 'tabToken') : null,
                    });
                }
                wsTap('agent.reply', summarizeActionEnvelope(response));
                socket.send(JSON.stringify(response));

                if (!isFailedAction(response) && isMutatingAction(action.type)) {
                    const data = isRecord(response.payload) ? response.payload : null;
                    const workspaceId = data ? getStringField(data, 'workspaceName') : null;
                    const tabId = data ? getStringField(data, 'tabName') : null;
                    broadcast({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: ACTION_TYPES.WORKSPACE_CHANGED,
                        payload: { workspaceName: workspaceId, tabName: tabId, sourceType: action.type },
                        workspaceName: workspaceId || undefined,
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
                    broadcastStateSync(`report:${action.type}`, {
                        workspaceName,
                        tabName,
                    });
                    broadcastWorkspaceList(`report:${action.type}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logError('action.dispatch.failed', { message });
                socket.send(
                    JSON.stringify({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: 'action.dispatch.failed',
                        payload: { code: ERROR_CODES.ERR_BAD_ARGS, message },
                        at: Date.now(),
                    } satisfies Action),
                );
            } finally {
                void recordingPersistence.flush();
            }
        })();
    });
    socket.on('close', () => wsClients.delete(socket));
});

/**
 * ========================= Listener Group C: Tab Ping Watchdog Timer =========================
 * 触发源：
 * - 固定周期定时器（TAB_PING_WATCHDOG_INTERVAL_MS）
 *
 * 职责：
 * - 检测超时未上报 ping 的 tabToken；
 * - 首次发现时广播 ping-timeout 状态同步；
 * - 触发 pageRegistry.closeTokenPage 回收失活页资源。
 *
 * 说明：
 * - staleNotifiedTokens 用于抑制重复通知，避免同一 token 反复刷屏。
 */
setInterval(() => {
    const staleTabs = pageRegistry.listTimedOutTokens(TAB_PING_TIMEOUT_MS, Date.now());
    for (const stale of staleTabs) {
        if (staleNotifiedTokens.has(stale.tabToken)) {continue;}
        staleNotifiedTokens.add(stale.tabToken);
        broadcastStateSync('ping-timeout', {
            workspaceName: stale.workspaceId,
            tabName: stale.tabId,
            lastSeenAt: stale.lastSeenAt,
        });
        void pageRegistry.closeTokenPage(stale.tabToken);
    }
}, TAB_PING_WATCHDOG_INTERVAL_MS);

(async () => {
    await contextManager.getContext();
    await controlServer.start();
    if (pageRegistry.listWorkspaces().length === 0) {
        const created = pageRegistry.createWorkspaceShell();
        assert.ok(created.workspaceId, 'bootstrap workspaceId missing');
        log('workspace.bootstrap.created', { workspaceId: created.workspaceId });
    }
    broadcastWorkspaceList('bootstrap');
    log(`Control RPC listening on ${controlServer.endpoint}`);
    log('Playwright Chromium launched with extension.');
})().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Fatal startup error:', message);
    throw error;
});
