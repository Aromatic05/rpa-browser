import path from 'node:path';
import fs from 'node:fs';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createWorkspaceRegistry } from './runtime/workspace_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { startMcpServer } from './mcp/index';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { getLogger, initLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { McpToolHost } from './mcp/hotreload/tool_host';
import { createActionDispatcher } from './actions/dispatcher';
import { createControlServer, registerControlShutdown, setControlActionDispatcher } from './control';
import { ensureWorkflowOnFs } from './workflow';

const TAB_NAME_KEY = '__rpa_tab_name';
const NAV_DEDUPE_WINDOW_MS = 1200;
if (!process.env.RPA_USER_DATA_DIR) {
    process.env.RPA_USER_DATA_DIR = path.resolve(process.cwd(), '.user-data-mcp');
}

const actionLog = getLogger('action');
const log = (...args: unknown[]) => { actionLog.info('[RPA:mcp]', ...args); };
const logNotice = (...args: unknown[]) => { actionLog.warning('[RPA:mcp]', ...args); };
const logError = (...args: unknown[]) => { actionLog.error('[RPA:mcp]', ...args); };

const paths = resolvePaths();
const recordingState = createRecordingState();
const workspaceRegistry = createWorkspaceRegistry();

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
const sourcePluginEntry = path.resolve(process.cwd(), 'src/runner/plugin_entry.ts');
const bundledPluginEntry = path.resolve(process.cwd(), '.runner-dist/plugin.mjs');
const hasSourcePluginEntry = fs.existsSync(sourcePluginEntry);
const pluginEntry = process.env.RUNNER_PLUGIN_ENTRY
    ? path.resolve(process.cwd(), process.env.RUNNER_PLUGIN_ENTRY)
    : hasSourcePluginEntry
      ? sourcePluginEntry
      : bundledPluginEntry;
const hotReloadDisabled = /^(0|false|off)$/i.test(String(process.env.RUNNER_HOT_RELOAD || '').trim());
const hotReloadEnabled = !hotReloadDisabled;
const runnerPluginHost = new RunnerPluginHost(pluginEntry);
await runnerPluginHost.load();
if (hotReloadEnabled) {
    const watchTarget =
        hasSourcePluginEntry && pluginEntry === sourcePluginEntry
            ? path.resolve(process.cwd(), 'src/runner')
            : path.resolve(process.cwd(), '.runner-dist');
    runnerPluginHost.watchDev(watchTarget);
    logNotice('Runner plugin hot reload enabled.', { pluginEntry, watchTarget });
} else {
    logNotice('Runner plugin hot reload disabled by RUNNER_HOT_RELOAD.', { pluginEntry });
}
const sourceMcpHotEntry = path.resolve(process.cwd(), 'src/mcp/hot_entry.ts');
const mcpToolHost = new McpToolHost(sourceMcpHotEntry);

const pageRegistry = createPageRegistry({
    tabNameKey: TAB_NAME_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, tabName) => {
        if (recordingState.recordingEnabled.has(tabName)) {
            void ensureRecorder(recordingState, page, tabName, NAV_DEDUPE_WINDOW_MS);
        }
        const workspaceName = workspaceRegistry.getActiveWorkspace()?.name || 'default';
        const workspace = workspaceRegistry.createWorkspace(workspaceName, ensureWorkflowOnFs(workspaceName));
        if (!workspace.tabRegistry.hasTab(tabName)) {
            workspace.tabRegistry.createTab({ tabName, page, url: page.url() });
        } else {
            workspace.tabRegistry.bindPage(tabName, page);
        }
        workspace.tabRegistry.setActiveTab(tabName);
        runtimeRegistry.bindPage({ workspaceName, tabName, page });
    },
    onBindingClosed: (tabName) => { cleanupRecording(recordingState, tabName); },
});
const runtimeRegistry: ReturnType<typeof createRuntimeRegistry> = createRuntimeRegistry({
    workspaceRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled
        ? createLoggingHooks()
        : createNoopHooks(),
    pluginHost: runnerPluginHost,
});
const runStepsDeps = {
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
};
setRunStepsDeps(runStepsDeps);
setControlActionDispatcher(
    createActionDispatcher({
        pageRegistry,
        workspaceRegistry,
        recordingState,
        log: (...args: unknown[]) => { actionLog.info('[RPA:mcp:action]', ...args); },
        replayOptions: {
            clickDelayMs: 300,
            stepDelayMs: 900,
            scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 },
        },
        navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        runStepsDeps,
    }),
);
const controlServer = createControlServer({ deps: runStepsDeps });
registerControlShutdown(controlServer, logNotice);
await mcpToolHost.load({
    pageRegistry,
    workspaceRegistry,
    config,
    log,
    runStepsDeps,
});
if (hotReloadEnabled) {
    const watchTarget = path.resolve(process.cwd(), 'src/mcp');
    mcpToolHost.watchDev(watchTarget, { pageRegistry, workspaceRegistry, config, log, runStepsDeps });
    logNotice('MCP tool hot reload enabled.', { entry: sourceMcpHotEntry, watchTarget });
}

void (async () => {
    try {
        await contextManager.getContext();
        await controlServer.start();
        logNotice(`Control RPC listening on ${controlServer.endpoint}`);
        logNotice('Playwright Chromium launched with extension.');
        await startMcpServer({
            pageRegistry,
            workspaceRegistry,
            config,
            log,
            runStepsDeps,
            resolveToolRuntime: () =>
                mcpToolHost.getRuntime() || {
                    handlers: {},
                    tools: [],
                },
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logError('Failed to launch MCP server:', message);
        process.exit(1);
    }
})();
