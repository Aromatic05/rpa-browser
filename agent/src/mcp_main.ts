import path from 'node:path';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { startMcpServer } from './mcp/index';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './runner/config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const CLICK_DELAY_MS = 300;
const REPLAY_STEP_DELAY_MS = 900;
const NAV_DEDUPE_WINDOW_MS = 1200;
const SCROLL_CONFIG = { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 };

const log = (...args: unknown[]) => console.error('[RPA:mcp]', ...args);
console.log = (...args: unknown[]) => console.error(...args);

const paths = resolvePaths();
const recordingState = createRecordingState();

const contextManager = createContextManager({
    extensionPath: paths.extensionPath,
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
const runnerPluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
await runnerPluginHost.load();
if (process.env.NODE_ENV !== 'production') {
    runnerPluginHost.watchDev(path.resolve(process.cwd(), '.runner-dist'));
}

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
});
setRunStepsDeps({
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
});

(async () => {
    try {
        await contextManager.getContext();
        log('Playwright Chromium launched with extension.');
        await startMcpServer({
            pageRegistry,
            recordingState,
            log,
            replayOptions: {
                clickDelayMs: CLICK_DELAY_MS,
                stepDelayMs: REPLAY_STEP_DELAY_MS,
                scroll: SCROLL_CONFIG,
            },
            navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('Failed to launch MCP server:', message);
        process.exit(1);
    }
})();
