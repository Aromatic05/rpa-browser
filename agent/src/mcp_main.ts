import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { startMcpServer } from './mcp/index';
import { createRunnerScopeRegistry } from './runner/runner_scope';

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

const pageRegistry = createPageRegistry({
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
        }
    },
    onTokenClosed: (token) => cleanupRecording(recordingState, token),
});
const runnerScope = createRunnerScopeRegistry(2);

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
            runInWorkspace: runnerScope.run,
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('Failed to launch MCP server:', message);
        process.exit(1);
    }
})();
