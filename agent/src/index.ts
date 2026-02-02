import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { executeAction, type ActionContext } from './actions/execute';
import { assertIsAction, makeErr, type Action } from './actions/action_protocol';
import { ERROR_CODES } from './actions/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './runner/config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, getLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';

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

const handleAction = async (action: Action) => {
    const scope = action.scope;
    const urlHint = typeof (action.payload as any)?.url === 'string' ? ((action.payload as any).url as string) : undefined;

    let tabToken = action.scope?.tabToken || action.tabToken;
    let page: any;
    if (scope?.workspaceId || scope?.tabId) {
        page = await pageRegistry.resolvePage({ workspaceId: scope?.workspaceId, tabId: scope?.tabId });
        tabToken = pageRegistry.resolveTabToken({ workspaceId: scope?.workspaceId, tabId: scope?.tabId });
    } else if (tabToken) {
        page = await pageRegistry.getPage(tabToken, urlHint);
    } else {
        page = await pageRegistry.resolvePage();
        tabToken = pageRegistry.resolveTabToken();
    }
    if (!tabToken) {
        return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing tabToken');
    }
    const resolvedScope = scope ? pageRegistry.resolveScope(scope) : pageRegistry.resolveScopeFromToken(tabToken);
    return runnerScope.run(resolvedScope.workspaceId, async () => {
        const ctx: ActionContext = {
            page,
            tabToken,
            pageRegistry,
            log: actionLogger,
            recordingState,
            replayOptions: {
                clickDelayMs: CLICK_DELAY_MS,
                stepDelayMs: REPLAY_STEP_DELAY_MS,
                scroll: SCROLL_CONFIG,
            },
            navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
            execute: undefined,
        };
        ctx.execute = (innerAction: Action) => executeAction(ctx, innerAction);
        actionLogger('action', { type: action.type, tabToken, id: action.id });
        return executeAction(ctx, action);
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
        let payload: any;
        try {
            payload = JSON.parse(data.toString());
        } catch {
            socket.send(JSON.stringify({ type: 'error', payload: makeErr('ERR_BAD_JSON', 'invalid json') }));
            return;
        }

        (async () => {
            try {
                if (payload?.cmd || payload?.type === 'cmd') {
                    const errorPayload = makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'legacy cmd not supported');
                    socket.send(JSON.stringify({ type: 'error', replyTo: payload?.id, payload: errorPayload }));
                    return;
                }
                assertIsAction(payload as unknown);
                const action = payload as Action;
                const response = await handleAction(action);
                if (response.ok) {
                    socket.send(
                        JSON.stringify({
                            type: `${action.type}.result`,
                            replyTo: action.id,
                            payload: response,
                        }),
                    );
                } else {
                    socket.send(
                        JSON.stringify({
                            type: 'error',
                            replyTo: action.id,
                            payload: response,
                        }),
                    );
                }
                if (response.ok) {
                    const data = response.data as any;
                    const mutating =
                        action.type === 'workspace.create' ||
                        action.type === 'workspace.setActive' ||
                        action.type === 'tab.create' ||
                        action.type === 'tab.setActive' ||
                        action.type === 'tab.close';
                    if (mutating) {
                        broadcast({
                            event: 'workspace.changed',
                            data: {
                                workspaceId: data?.workspaceId,
                                tabId: data?.tabId,
                                type: action.type,
                            },
                        });
                    }
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                socket.send(JSON.stringify({ type: 'error', payload: makeErr(ERROR_CODES.ERR_BAD_ARGS, message) }));
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
