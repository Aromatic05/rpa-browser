import { WebSocketServer } from 'ws';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { executeCommand, type ActionContext } from './runner/execute';
import type { Command } from './runner/commands';
import { errorResult } from './runner/results';
import { ERROR_CODES } from './runner/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const CLICK_DELAY_MS = 300;
const REPLAY_STEP_DELAY_MS = 900;
const NAV_DEDUPE_WINDOW_MS = 1200;
const SCROLL_CONFIG = { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 };

const log = (...args: unknown[]) => console.log('[RPA:agent]', ...args);

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

const handleCommand = async (payload?: Command) => {
    if (!payload?.cmd) {
        return errorResult('', ERROR_CODES.ERR_BAD_ARGS, 'missing cmd');
    }
    if (!payload.tabToken) {
        return errorResult('', ERROR_CODES.ERR_BAD_ARGS, 'missing tabToken', payload.requestId);
    }
    const urlHint =
        typeof (payload as any).args?.url === 'string' ? ((payload as any).args.url as string) : undefined;
    const page = await pageRegistry.getPage(payload.tabToken, urlHint);
    const scope = pageRegistry.resolveScopeFromToken(payload.tabToken);
    return runnerScope.run(scope.workspaceId, async () => {
        const ctx: ActionContext = {
            page,
            tabToken: payload.tabToken,
            pageRegistry,
            log,
            recordingState,
            replayOptions: {
                clickDelayMs: CLICK_DELAY_MS,
                stepDelayMs: REPLAY_STEP_DELAY_MS,
                scroll: SCROLL_CONFIG,
            },
            navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
            execute: undefined,
        };
        ctx.execute = (cmd: Command) => executeCommand(ctx, cmd);
        log('cmd', { cmd: payload.cmd, tabToken: payload.tabToken, requestId: payload.requestId });
        return executeCommand(ctx, payload);
    });
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: 17333 });

wss.on('listening', () => {
    log('WS listening on ws://127.0.0.1:17333');
});

wss.on('connection', (socket) => {
    socket.on('message', (data) => {
        let payload: { cmd?: Command } | undefined;
        try {
            payload = JSON.parse(data.toString());
        } catch {
            socket.send(JSON.stringify({ ok: false, error: 'invalid json' }));
            return;
        }

        (async () => {
            try {
                const response = await handleCommand(payload?.cmd);
                socket.send(JSON.stringify(response));
            } catch (error) {
                socket.send(
                    JSON.stringify({
                        ok: false,
                        error: error instanceof Error ? error.message : String(error),
                    }),
                );
            }
        })();
    });
});

(async () => {
    try {
        await contextManager.getContext();
        log('Playwright Chromium launched with extension.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('Failed to launch Playwright Chromium:', message);
    }
})();
