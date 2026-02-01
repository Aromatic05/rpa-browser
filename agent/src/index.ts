import { WebSocketServer, WebSocket } from 'ws';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { executeCommand, type ActionContext } from './runner/execute';
import type { Command } from './runner/commands';
import { errorResult } from './runner/results';
import { ERROR_CODES } from './runner/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './runner/config';

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

let runtimeRegistry: ReturnType<typeof createRuntimeRegistry>;

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
        try {
            const scope = pageRegistry.resolveScopeFromToken(token);
            broadcast({
                event: 'page.bound',
                data: {
                    workspaceId: scope.workspaceId,
                    tabId: scope.tabId,
                    tabToken: token,
                    url: page.url(),
                },
            });
        } catch {
            // ignore scope resolution failures
        }
    },
    onTokenClosed: (token) => cleanupRecording(recordingState, token),
});
const runnerScope = createRunnerScopeRegistry(2);
runtimeRegistry = createRuntimeRegistry({
    pageRegistry,
});
setRunStepsDeps({
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config: getRunnerConfig(),
});

const handleCommand = async (payload?: Command) => {
    if (!payload?.cmd) {
        return errorResult('', ERROR_CODES.ERR_BAD_ARGS, 'missing cmd');
    }
    const scope =
        (payload as any).scope ||
        ((payload as any).workspaceId || (payload as any).tabId
            ? { workspaceId: (payload as any).workspaceId, tabId: (payload as any).tabId }
            : undefined);
    const urlHint =
        typeof (payload as any).args?.url === 'string' ? ((payload as any).args.url as string) : undefined;
    let tabToken = payload.tabToken;
    let page: typeof payload extends { tabToken: string } ? any : any;
    if (scope) {
        page = await pageRegistry.resolvePage(scope);
        tabToken = pageRegistry.resolveTabToken(scope);
    } else if (tabToken) {
        page = await pageRegistry.getPage(tabToken, urlHint);
    } else {
        page = await pageRegistry.resolvePage();
        tabToken = pageRegistry.resolveTabToken();
    }
    if (!tabToken) {
        return errorResult('', ERROR_CODES.ERR_BAD_ARGS, 'missing tabToken', payload.requestId);
    }
    const resolvedScope = scope ? pageRegistry.resolveScope(scope) : pageRegistry.resolveScopeFromToken(tabToken);
    return runnerScope.run(resolvedScope.workspaceId, async () => {
        const ctx: ActionContext = {
            page,
            tabToken,
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
        log('cmd', { cmd: payload.cmd, tabToken, requestId: payload.requestId });
        return executeCommand(ctx, payload);
    });
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: 17333 });
const wsClients = new Set<WebSocket>();

const broadcast = (event: { event: string; data?: Record<string, unknown> }) => {
    const payload = JSON.stringify({ type: 'event', ...event });
    wsClients.forEach((client) => {
        try {
            if (client.readyState === client.OPEN) {
                client.send(payload);
            }
        } catch {
            // ignore send failures
        }
    });
};

wss.on('listening', () => {
    log('WS listening on ws://127.0.0.1:17333');
});

wss.on('connection', (socket) => {
    wsClients.add(socket);
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
                const command = (payload as any)?.type === 'cmd' ? (payload as any).cmd : payload?.cmd;
                const response = await handleCommand(command);
                if ((payload as any)?.type === 'cmd') {
                    socket.send(
                        JSON.stringify({
                            type: 'result',
                            requestId: command?.requestId,
                            payload: response,
                        }),
                    );
                } else {
                    socket.send(JSON.stringify(response));
                }
                if (command?.cmd && response?.ok) {
                    const data = response.data as any;
                    const mutating =
                        command.cmd === 'workspace.create' ||
                        command.cmd === 'workspace.setActive' ||
                        command.cmd === 'tab.create' ||
                        command.cmd === 'tab.setActive' ||
                        command.cmd === 'tab.close';
                    if (mutating) {
                        broadcast({
                            event: 'workspace.changed',
                            data: {
                                workspaceId: data?.workspaceId,
                                tabId: data?.tabId,
                                cmd: command.cmd,
                            },
                        });
                    }
                }
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
    socket.on('close', () => {
        wsClients.delete(socket);
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
