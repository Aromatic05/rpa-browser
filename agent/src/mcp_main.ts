import crypto from 'node:crypto';
import path from 'node:path';
import type { Page } from 'playwright';
import type { Action } from './actions/action_protocol';
import { createContextManager, resolvePaths } from './runtime/browser/context_manager';
import { createPageRegistry } from './runtime/browser/page_registry';
import { createWorkspaceRegistry } from './runtime/workspace/registry';
import { createExecutionBindings } from './runtime/execution/bindings';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { getLogger, initLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { createActionDispatcher } from './actions/dispatcher';
import { createControlServer, registerControlShutdown, setControlActionDispatcher } from './control';
import { ensureWorkflowOnFs } from './workflow';
import { createPortAllocator } from './runtime/service/ports';
import type { RunStepsDeps } from './runner/run_steps_types';

const TAB_NAME_KEY = '__rpa_tab_name';
const NAV_DEDUPE_WINDOW_MS = 1200;
const REPLAY_OPTIONS = {
    clickDelayMs: 300,
    stepDelayMs: 900,
    scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 },
};
if (!process.env.RPA_USER_DATA_DIR) {
    process.env.RPA_USER_DATA_DIR = path.resolve(process.cwd(), '.user-data-mcp');
}

const actionLog = getLogger('action');
const log = (...args: unknown[]) => { actionLog.info('[RPA:mcp]', ...args); };
const logNotice = (...args: unknown[]) => { actionLog.warning('[RPA:mcp]', ...args); };
const logError = (...args: unknown[]) => { actionLog.error('[RPA:mcp]', ...args); };

const paths = resolvePaths();
const recordingState = createRecordingState();
let onPageBoundHook: (page: Page, tabName: string) => void = () => undefined;
let onBindingClosedHook: (tabName: string) => void = () => undefined;

const contextManager = createContextManager({
    extensionPaths: paths.extensionPaths,
    userDataDir: paths.userDataDir,
    onPage: (page) => {
        void pageRegistry.bindPage(page);
    },
});

const config = getRunnerConfig();
initLogger(config);
const traceSinks = config.observability.traceFileEnabled
    ? [new FileSink(resolveLogPath(config.observability.traceFilePath))]
    : [];
const runnerPluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
await runnerPluginHost.load();

const pageRegistry = createPageRegistry({
    tabNameKey: TAB_NAME_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, tabName) => onPageBoundHook(page, tabName),
    onBindingClosed: (tabName) => onBindingClosedHook(tabName),
});

const runtimeRegistry = createExecutionBindings({
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled
        ? createLoggingHooks()
        : createNoopHooks(),
    pluginHost: runnerPluginHost,
});

const runStepsDeps: RunStepsDeps = {
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
};
setRunStepsDeps(runStepsDeps);

const portAllocator = createPortAllocator();

const workspaceRegistry = createWorkspaceRegistry({
    pageRegistry,
    recordingState,
    replayOptions: REPLAY_OPTIONS,
    navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
    runStepsDeps,
    runnerConfig: config,
    portAllocator,
});
runStepsDeps.resolveEntityRulesProvider = (workspaceName: string) => {
    const workspace = workspaceRegistry.getWorkspace(workspaceName);
    if (!workspace) {
        return null;
    }
    return workspace.entityRules.getProvider(workspace.workflow);
};

onPageBoundHook = (page, tabName) => {
    if (recordingState.recordingEnabled.has(tabName)) {
        void ensureRecorder(recordingState, page, tabName, NAV_DEDUPE_WINDOW_MS);
    }
    const workspaceName = workspaceRegistry.getActiveWorkspace()?.name || 'default';
    const workspace = workspaceRegistry.createWorkspace(workspaceName, ensureWorkflowOnFs(workspaceName));
    if (!workspace.tabs.hasTab(tabName)) {
        workspace.tabs.createTab({ tabName, page, url: page.url() });
    } else {
        workspace.tabs.bindPage(tabName, page);
    }
    workspace.tabs.setActiveTab(tabName);
    runtimeRegistry.bindPage({ workspaceName, tabName, page });
};
onBindingClosedHook = (tabName) => { cleanupRecording(recordingState, tabName); };

setControlActionDispatcher(
    createActionDispatcher({
        workspaceRegistry,
        log: (...args: unknown[]) => { actionLog.info('[RPA:mcp:action]', ...args); },
    }),
);
const controlServer = createControlServer({ deps: runStepsDeps });
registerControlShutdown(controlServer, logNotice);

void (async () => {
    try {
        await contextManager.getContext();
        await controlServer.start();
        logNotice(`Control RPC listening on ${controlServer.endpoint}`);
        logNotice('Playwright Chromium launched with extension.');

        const workspace = workspaceRegistry.createWorkspace('default', ensureWorkflowOnFs('default'));
        const mcpStartAction: Action = { v: 1, id: crypto.randomUUID(), type: 'mcp.start', workspaceName: workspace.name, payload: {}, at: Date.now() };
        const mcpControlResult = await workspace.mcp.handle(mcpStartAction, workspace);
        const mcpResult = mcpControlResult.reply.payload as { workspaceName: string; serviceName: string; port: number; status: string };
        logNotice('Workspace MCP server started', {
            workspaceName: mcpResult.workspaceName,
            serviceName: mcpResult.serviceName,
            port: mcpResult.port,
            status: mcpResult.status,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to launch MCP server:', message);
        process.exit(1);
    }
})();
