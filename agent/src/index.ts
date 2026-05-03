import crypto from 'node:crypto';
import path from 'node:path';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createWorkspaceRegistry } from './runtime/workspace_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import {
    createRecordingState,
    ensureRecorder,
    getWorkspaceActiveRecordingToken,
    attachTabToRecordingManifest,
    cleanupRecording,
} from './record/recording';
import { setRecorderRuntimeEnabled } from './record/recorder';
import { loadRecordingStateFromFile, startRecordingStateAutoSave } from './record/persistence';
import { failedAction, type Action } from './actions/action_protocol';
import { ERROR_CODES } from './actions/results';
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
import { createRuntimeLifecycle } from './runtime/lifecycle';
import { installRecorderEventSink } from './record/sink';
import { createPortAllocator } from './runtime/port_allocator';
import type { RunStepsDeps } from './runner/run_steps_types';

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
const wsTap = (stage: string, data: Record<string, unknown>) => {
    if (!WS_TAP_ENABLED) {return;}
    actionLog.warning('[RPA:ws.tap]', { ts: Date.now(), stage, ...data });
};
let broadcast: (action: Action) => void = () => undefined;

const paths = resolvePaths();
const recordingState = createRecordingState();
const recordingStatePath = path.resolve(paths.userDataDir, 'recordings.state.json');
await loadRecordingStateFromFile(recordingState, recordingStatePath);
const recordingPersistence = startRecordingStateAutoSave(recordingState, recordingStatePath, {
    intervalMs: 1500,
    onError: (error) => { actionLog.error('[RPA:agent]', 'recording persistence error', String(error)); },
});

let onPageBoundHook: (page: Page, bindingName: string) => void = () => undefined;
let onBindingClosedHook: (bindingName: string) => void = () => undefined;

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

const pageRegistry = createPageRegistry({
    tabNameKey: TAB_NAME_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, bindingName) => onPageBoundHook(page, bindingName),
    onBindingClosed: (bindingName) => onBindingClosedHook(bindingName),
});

const runtimeRegistry = createRuntimeRegistry({
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled ? createLoggingHooks() : createNoopHooks(),
    pluginHost: runnerPluginHost,
});

const runStepsDeps: RunStepsDeps = {
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
};
setRunStepsDeps(runStepsDeps);

const workspaceRegistry = createWorkspaceRegistry({
    pageRegistry,
    recordingState,
    replayOptions: REPLAY_OPTIONS,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    emit: (action) => broadcast(action),
    runStepsDeps,
    runnerConfig: config,
    portAllocator: createPortAllocator(),
});
runStepsDeps.resolveEntityRulesProvider = (workspaceName: string) => {
    const workspace = workspaceRegistry.getWorkspace(workspaceName);
    if (!workspace) {
        return null;
    }
    return workspace.controls.entityRules.getProvider(workspace.workflow);
};

const lifecycle = createRuntimeLifecycle({
    workspaceRegistry,
    runtimeRegistry,
    recordingState,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    pingTimeoutMs: TAB_PING_TIMEOUT_MS,
    pingWatchdogIntervalMs: TAB_PING_WATCHDOG_INTERVAL_MS,
    emit: (action) => broadcast(action),
    ensureWorkflow: ensureWorkflowOnFs,
    ensureRecorder,
    setRecorderRuntimeEnabled,
    getWorkspaceActiveRecordingToken,
    attachTabToRecordingManifest,
    cleanupRecording,
});
onPageBoundHook = lifecycle.onPageBound;
onBindingClosedHook = lifecycle.onBindingClosed;
lifecycle.startWatchdog(pageRegistry);

installRecorderEventSink({
    recordingState,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    emit: (action) => broadcast(action),
    findWorkspaceNameByTabName: lifecycle.findWorkspaceNameByTabName,
    wsTap,
});

const runnerScope = createRunnerScopeRegistry(2);
const actionDispatcher = createActionDispatcher({
    workspaceRegistry,
    log: actionLogger,
    emit: (action) => broadcast(action),
});
setControlActionDispatcher(actionDispatcher);

const handleAction = async (action: Action) => {
    log('action.inbound', {
        id: action.id,
        type: action.type,
        workspaceName: action.workspaceName || null,
    });

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

const actionWsClient = startActionWsClient({
    port: WS_PORT,
    host: '127.0.0.1',
    workspaceRegistry,
    dispatchAction: async (action) => {
        try {
            return await handleAction(action);
        } finally {
            void recordingPersistence.flush();
        }
    },
    onError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logError('action.dispatch.failed', { message });
    },
    onListening: (url) => { log(`WS listening on ${url}`); },
    wsTap,
});
broadcast = actionWsClient.broadcastAction;

const controlServer = createControlServer({ deps: runStepsDeps });
registerControlShutdown(controlServer, log);

(async () => {
    await contextManager.getContext();
    await controlServer.start();
    if (workspaceRegistry.listWorkspaces().length === 0) {
        const created = workspaceRegistry.createWorkspace('default', ensureWorkflowOnFs('default'));
        assert.ok(created.name, 'bootstrap workspaceName missing');
        log('workspace.bootstrap.created', { workspaceName: created.name });
    }
    broadcast({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_SYNC,
        payload: { reason: 'bootstrap' },
        at: Date.now(),
    });
    log(`Control RPC listening on ${controlServer.endpoint}`);
    log('Playwright Chromium launched with extension.');
})().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Fatal startup error:', message);
    throw error;
});
