import path from 'node:path';
import fs from 'node:fs';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { startMcpServer } from './mcp/index';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { getLogger, initLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { McpToolHost } from './mcp/hotreload/tool_host';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const NAV_DEDUPE_WINDOW_MS = 1200;
if (!process.env.RPA_USER_DATA_DIR) {
    process.env.RPA_USER_DATA_DIR = path.resolve(process.cwd(), '.user-data-mcp');
}

const actionLog = getLogger('action');
const log = (...args: unknown[]) => actionLog.info('[RPA:mcp]', ...args);
const logNotice = (...args: unknown[]) => actionLog.warning('[RPA:mcp]', ...args);
const logError = (...args: unknown[]) => actionLog.error('[RPA:mcp]', ...args);

const paths = resolvePaths();
const recordingState = createRecordingState();

const contextManager = createContextManager({
    extensionPaths: paths.extensionPaths,
    userDataDir: paths.userDataDir,
    onPage: (page) => {
        void pageRegistry.bindPage(page);
    },
});

let runtimeRegistry: ReturnType<typeof createRuntimeRegistry>;

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
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
        }
        if (runtimeRegistry) {
            runtimeRegistry.bindPage(page, token);
        }
    },
    onTokenClosed: (token) => cleanupRecording(recordingState, token),
});
runtimeRegistry = createRuntimeRegistry({
    pageRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled
        ? createLoggingHooks()
        : createNoopHooks(),
    pluginHost: runnerPluginHost,
});
setRunStepsDeps({
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
});
await mcpToolHost.load({
    pageRegistry,
    config,
    log,
});
if (hotReloadEnabled) {
    const watchTarget = path.resolve(process.cwd(), 'src/mcp');
    mcpToolHost.watchDev(watchTarget, { pageRegistry, config, log });
    logNotice('MCP tool hot reload enabled.', { entry: sourceMcpHotEntry, watchTarget });
}

(async () => {
    try {
        await contextManager.getContext();
        logNotice('Playwright Chromium launched with extension.');
        await startMcpServer({
            pageRegistry,
            config,
            log,
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
