import path from 'node:path';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { resolvePaths } from './runtime/browser/context_manager';
import { createWorkspaceRegistry } from './runtime/workspace/registry';
import { createExecutionBindings } from './runtime/execution/bindings';
import {
    createRecordingState,
    ensureRecorder,
    isWorkspaceRecordingEnabled,
    attachTabToRecordingManifest,
    cleanupRecording,
} from './record/recording';
import { setRecorderRuntimeEnabled } from './record/capture/recorder';
import { failedAction, type Action } from './actions/action_protocol';
import { ERROR_CODES } from './actions/results';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, getLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { createActionDispatcher } from './actions/dispatcher';
import { createControlServer, registerControlShutdown } from './control';
import { ensureWorkflowOnFs } from './workflow';
import { createRuntimeLifecycle } from './runtime/browser/lifecycle';
import { installRecorderEventSink } from './record/sink';
import { createPortAllocator } from './runtime/service/ports';
import type { RunStepsDeps } from './runner/run_steps_types';

const TAB_NAME_KEY = '__rpa_tab_name';
const TAB_PING_TIMEOUT_MS = 45000;
const TAB_PING_WATCHDOG_INTERVAL_MS = 5000;
const REPLAY_OPTIONS = {
    clickDelayMs: 300,
    stepIntervalMs: 900,
    scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 },
};
const NAV_DEDUPE_WINDOW_MS = 1200;
const actionLog = getLogger('action');
const log = (...args: unknown[]) => { actionLog.info('[RPA:agent]', ...args); };
const logWarning = (...args: unknown[]) => { actionLog.warning('[RPA:agent]', ...args); };
const logError = (...args: unknown[]) => { actionLog.error('[RPA:agent]', ...args); };
const WS_TAP_ENABLED = process.env.RPA_WS_TAP === '1';

const wsTap = (stage: string, data: Record<string, unknown>) => {
    if (!WS_TAP_ENABLED) {return;}
    actionLog.warning('[RPA:ws.tap]', { ts: Date.now(), stage, ...data });
};
let workspaceRegistry: ReturnType<typeof createWorkspaceRegistry>;
let dispatchActionForTrace: (action: Action) => Promise<Action> = async () => {
    throw new Error('dispatchAction not initialized');
};

const emitAction = (action: Action) => {
    if (action.workspaceName) {
        workspaceRegistry.getWorkspace(action.workspaceName)?.browserSession.emit(action);
        return;
    }
    for (const workspace of workspaceRegistry.listWorkspaces()) {
        workspace.browserSession.emit(action);
    }
};

const paths = resolvePaths();
const recordingState = createRecordingState();

let onPageBoundHook: (page: Page, bindingName: string) => void = () => undefined;
let onBindingClosedHook: (bindingName: string) => void = () => undefined;

const config = getRunnerConfig();
initLogger(config);

process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    actionLog.error('[RPA:agent]', 'unhandled rejection', { message, stack: reason instanceof Error ? reason.stack : undefined });
});
process.on('uncaughtException', (error) => {
    actionLog.error('[RPA:agent]', 'uncaught exception', {
        message: error.message,
        stack: error.stack,
    });
    process.exit(1);
});

const actionLogger = getLogger('action');
const traceSinks = config.observability.traceFileEnabled
    ? [new FileSink(resolveLogPath(config.observability.traceFilePath))]
    : [];
const runnerPluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
await runnerPluginHost.load();
if (process.env.NODE_ENV !== 'production') {
    runnerPluginHost.watchDev(path.resolve(process.cwd(), '.runner-dist'));
}

const runtimeRegistry = createExecutionBindings({
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled ? createLoggingHooks() : createNoopHooks(),
    pluginHost: runnerPluginHost,
    dispatchAction: async (action) => await dispatchActionForTrace(action),
});

const runStepsDeps: RunStepsDeps = {
    runtime: runtimeRegistry,
    resolveWorkspace: (workspaceName: string) => {
        const workspace = workspaceRegistry.getWorkspace(workspaceName);
        if (!workspace) {
            throw new Error(`workspace not found: ${workspaceName}`);
        }
        return workspace;
    },
    dispatchAction: async () => {
        throw new Error('dispatchAction not initialized');
    },
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
};
setRunStepsDeps(runStepsDeps);

workspaceRegistry = createWorkspaceRegistry({
    tabNameKey: TAB_NAME_KEY,
    extensionPaths: paths.extensionPaths,
    userDataRoot: paths.userDataRoot,
    runtime: runtimeRegistry,
    recordingState,
    replayOptions: REPLAY_OPTIONS,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    emit: (action) => emitAction(action),
    runStepsDeps,
    runnerConfig: config,
    portAllocator: createPortAllocator(),
    dispatchAction: async (action) => await handleAction(action),
    onPageBound: (page, bindingName) => onPageBoundHook(page, bindingName),
    onBindingClosed: (bindingName) => onBindingClosedHook(bindingName),
    onWsError: (error) => {
        const message = error instanceof Error ? error.message : String(error);
        logError('action.dispatch.failed', { message });
    },
    onWsListening: (workspaceName, url) => { log('workspace WS listening', { workspaceName, url }); },
    wsTap,
});
runStepsDeps.resolveEntityRulesProvider = (workspaceName: string) => {
    const workspace = workspaceRegistry.getWorkspace(workspaceName);
    if (!workspace) {
        return null;
    }
    return workspace.entityRules.getProvider(workspace.workflow);
};

const lifecycle = createRuntimeLifecycle({
    workspaceRegistry,
    runtimeRegistry,
    recordingState,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    pingTimeoutMs: TAB_PING_TIMEOUT_MS,
    pingWatchdogIntervalMs: TAB_PING_WATCHDOG_INTERVAL_MS,
    emit: (action) => emitAction(action),
    ensureWorkflow: ensureWorkflowOnFs,
    ensureRecorder,
    setRecorderRuntimeEnabled,
    isWorkspaceRecordingEnabled,
    attachTabToRecordingManifest,
    cleanupRecording,
});
onPageBoundHook = lifecycle.onPageBound;
onBindingClosedHook = lifecycle.onBindingClosed;
lifecycle.startWatchdog();

installRecorderEventSink({
    recordingState,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    emit: (action) => emitAction(action),
    findWorkspaceNameByTabName: lifecycle.findWorkspaceNameByTabName,
    wsTap,
});

const runnerScope = createRunnerScopeRegistry(2);
const actionDispatcher = createActionDispatcher({
    workspaceRegistry,
    log: actionLogger,
    emit: (action) => emitAction(action),
});
dispatchActionForTrace = async (action) => await actionDispatcher.dispatch(action);
runStepsDeps.dispatchAction = async (action) => await actionDispatcher.dispatch(action);

const handleAction = async (action: Action) => {
    log('action.inbound', {
        id: action.id,
        type: action.type,
        workspaceName: action.workspaceName || null,
        payload: action.payload ?? null,
        payloadKeys:
            action.payload && typeof action.payload === 'object'
                ? Object.keys(action.payload as Record<string, unknown>)
                : [],
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

const controlServer = createControlServer({
    evalContext: {
        deps: runStepsDeps,
        workspaceRegistry,
        config,
        dispatch: async (action) => await actionDispatcher.dispatch(action),
        resolveWorkspace: (workspaceName: string) => workspaceRegistry.getWorkspace(workspaceName),
        checkpointProvider: (workspaceName: string) => {
            const workspace = workspaceRegistry.getWorkspace(workspaceName);
            if (!workspace) {
                return undefined;
            }
            return workspace.checkpoint.getProvider(workspace.workflow);
        },
    },
});
registerControlShutdown(controlServer, log);

(async () => {
    await controlServer.start();
    if (workspaceRegistry.listWorkspaces().length === 0) {
        const created = workspaceRegistry.createWorkspace('default', ensureWorkflowOnFs('default'));
        assert.ok(created.name, 'bootstrap workspaceName missing');
        log('workspace.bootstrap.created', { workspaceName: created.name });
    }
    log(`Control RPC listening on ${controlServer.endpoint}`);
    log('Agent runtime initialized.');
})().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Fatal startup error:', message);
    throw error;
});
