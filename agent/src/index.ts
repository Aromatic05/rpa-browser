import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder } from './record/recording';
import { loadRecordingStateFromFile, startRecordingStateAutoSave } from './record/persistence';
import { executeAction, type ActionContext } from './actions/execute';
import { makeErr, type Action } from './actions/action_protocol';
import { ERROR_CODES } from './actions/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './runner/config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, getLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { resolveActionTarget, ActionTargetError } from './runtime/action_target';
import { ACTION_TYPES, isActionType } from './actions/action_types';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const WS_PORT = Number(process.env.RPA_WS_PORT || 17333);
const PAGELESS_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_LIST,
    ACTION_TYPES.RECORD_LIST,
    ACTION_TYPES.TAB_INIT,
]);
const TAB_PING_TIMEOUT_MS = 45000;
const TAB_PING_WATCHDOG_INTERVAL_MS = 5000;
const REPLAY_OPTIONS = {
    clickDelayMs: 300,
    stepDelayMs: 900,
    scroll: { minDelta: 220, maxDelta: 520, minSteps: 2, maxSteps: 4 },
};
const NAV_DEDUPE_WINDOW_MS = 1200;

const actionLog = getLogger('action');
const log = (...args: unknown[]) => actionLog('[RPA:agent]', ...args);
const logTabReportDebug = (stage: string, data: Record<string, unknown>) =>
    actionLog('[RPA:tab.report]', { ts: Date.now(), stage, ...data });

const paths = resolvePaths();
const recordingState = createRecordingState();
const recordingStatePath = path.resolve(paths.userDataDir, 'recordings.state.json');
await loadRecordingStateFromFile(recordingState, recordingStatePath);
const recordingPersistence = startRecordingStateAutoSave(recordingState, recordingStatePath, {
    intervalMs: 1500,
    onError: (error) => actionLog('[RPA:agent]', 'recording persistence error', String(error)),
});

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
const actionLogger = getLogger('action');
const traceSinks = config.observability.traceFileEnabled
    ? [new FileSink(resolveLogPath(config.observability.traceFilePath))]
    : [];
const runnerPluginHost = new RunnerPluginHost(path.resolve(process.cwd(), '.runner-dist/plugin.mjs'));
await runnerPluginHost.load();
if (process.env.NODE_ENV !== 'production') {
    runnerPluginHost.watchDev(path.resolve(process.cwd(), '.runner-dist'));
}

const wsClients = new Set<WebSocket>();
const broadcast = (action: Action) => {
    const payload = JSON.stringify(action);
    wsClients.forEach((client) => {
        try {
            if (client.readyState === client.OPEN) client.send(payload);
        } catch {
            // ignore
        }
    });
};

const REPORT_STATE_SYNC_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.WORKSPACE_RESTORE,
    ACTION_TYPES.TAB_CREATE,
    ACTION_TYPES.TAB_OPENED,
    ACTION_TYPES.TAB_REPORTED,
    ACTION_TYPES.TAB_CLOSED,
    ACTION_TYPES.TAB_REASSIGN,
]);
const staleNotifiedTokens = new Set<string>();

const broadcastStateSync = (reason: string, data?: Record<string, unknown>) => {
    broadcast({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_SYNC,
        payload: { reason, ...(data || {}) },
        scope: {},
        at: Date.now(),
    });
};

const broadcastWorkspaceList = (reason: string) => {
    const active = pageRegistry.getActiveWorkspace?.();
    broadcast({
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_LIST,
        payload: {
            reason,
            workspaces: pageRegistry.listWorkspaces(),
            activeWorkspaceId: active?.workspaceId || null,
        },
        scope: {},
        at: Date.now(),
    });
};

const pageRegistry = createPageRegistry({
    tabTokenKey: TAB_TOKEN_KEY,
    getContext: contextManager.getContext,
    onPageBound: (page, token) => {
        if (recordingState.recordingEnabled.has(token)) {
            void ensureRecorder(recordingState, page, token, NAV_DEDUPE_WINDOW_MS);
        }
        if (runtimeRegistry) runtimeRegistry.bindPage(page, token);
        try {
            const scope = pageRegistry.resolveScopeFromToken(token);
            broadcast({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_BOUND,
                payload: { workspaceId: scope.workspaceId, tabId: scope.tabId, tabToken: token, url: page.url() },
                scope: { workspaceId: scope.workspaceId, tabId: scope.tabId, tabToken: token },
                at: Date.now(),
            });
        } catch {
            // ignore
        }
    },
    onTokenClosed: (token) => cleanupRecording(recordingState, token),
});

const runnerScope = createRunnerScopeRegistry(2);
runtimeRegistry = createRuntimeRegistry({
    pageRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled ? createLoggingHooks() : createNoopHooks(),
    pluginHost: runnerPluginHost,
});
setRunStepsDeps({
    runtime: runtimeRegistry,
    stepSinks: [createConsoleStepSink('[step]')],
    config,
    pluginHost: runnerPluginHost,
});

const createActionContext = (page: any, tabToken: string): ActionContext => {
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry,
        log: actionLogger,
        recordingState,
        replayOptions: REPLAY_OPTIONS,
        navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        execute: undefined,
    };
    ctx.execute = (innerAction: Action) => executeAction(ctx, innerAction);
    return ctx;
};

const isRealWebUrl = (url?: string) => !!url && (url.startsWith('http://') || url.startsWith('https://'));

const runAction = async (
    action: Action,
    target: { tabToken: string; scope: { workspaceId: string; tabId: string } },
    urlHint?: string,
    extra?: Record<string, unknown>,
) => {
    log('action.target.resolved', {
        id: action.id,
        type: action.type,
        tabToken: target.tabToken,
        scope: target.scope,
        extra: extra || null,
    });
    const page = await pageRegistry.getPage(target.tabToken, urlHint);
    return runnerScope.run(target.scope.workspaceId, async () => {
        actionLogger('action', { type: action.type, tabToken: target.tabToken, id: action.id, ...(extra || {}) });
        return executeAction(createActionContext(page, target.tabToken), action);
    });
};

const runPagelessAction = async (action: Action, tabToken = '') => {
    const pageStub = new Proxy(
        {},
        {
            get: (_target, prop) => {
                throw new Error(`action '${action.type}' accessed page.${String(prop)} without target`);
            },
        },
    ) as any;
    actionLogger('action', { type: action.type, tabToken: tabToken || null, id: action.id, mode: 'pageless' });
    return executeAction(createActionContext(pageStub, tabToken), action);
};

let orphanClaimChain = Promise.resolve();
const withOrphanClaimLock = async <T>(fn: () => Promise<T>): Promise<T> => {
    const prev = orphanClaimChain;
    let release: (() => void) | undefined;
    orphanClaimChain = new Promise<void>((resolve) => {
        release = resolve;
    });
    await prev;
    try {
        return await fn();
    } finally {
        if (release) release();
    }
};

const handleOrphanTokenAction = async (action: Action, urlHint?: string) => {
    const token = String(action.scope?.tabToken || action.tabToken || '');
    if (!token) return null;
    const payload = (action.payload || {}) as Record<string, unknown>;

    if (action.type === ACTION_TYPES.TAB_OPENED) {
        const workspaceId =
            (typeof payload.workspaceId === 'string' ? payload.workspaceId : '') ||
            (typeof action.scope?.workspaceId === 'string' ? action.scope.workspaceId : '');
        if (!workspaceId) {
            log('orphan.tab_opened.missing_workspace', {
                id: action.id,
                tabToken: token,
                scope: action.scope || null,
                payload: action.payload || null,
            });
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'tab.opened requires workspaceId');
        }
        const scoped = pageRegistry.claimOrphanTokenToWorkspace(token, workspaceId);
        if (!scoped) {
            log('orphan.tab_opened.bind_failed', {
                id: action.id,
                tabToken: token,
                workspaceId,
            });
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'failed to bind tab.opened to workspace');
        }
        return runAction(action, { tabToken: token, scope: scoped }, urlHint, { orphanClaim: true, byWindow: true });
    }

    if (action.type === ACTION_TYPES.WORKSPACE_RESTORE) {
        return runPagelessAction(action, token);
    }

    if (action.type === ACTION_TYPES.TAB_PING) {
        const source = String(payload.source || '');
        if (source !== 'extension.workspace.create') {
            log('orphan.tab_ping.forbidden', {
                id: action.id,
                tabToken: token,
                source,
                payload: action.payload || null,
            });
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'tab.ping orphan claim is forbidden without window mapping');
        }
    }

    const maybeUrl =
        (typeof payload.url === 'string' ? payload.url : '') || pageRegistry.getTokenPageUrl(token) || '';
    if (!isRealWebUrl(maybeUrl)) {
        return {
            ok: true as const,
            data: { tabToken: token, orphan: true, pending: true, reportedUrl: maybeUrl || null },
        };
    }

    return withOrphanClaimLock(async () => {
        const scope = pageRegistry.claimOrphanToken(token);
        if (!scope) {
            log('orphan.claim_failed', {
                id: action.id,
                tabToken: token,
                type: action.type,
                payload: action.payload || null,
            });
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'failed to claim orphan tab');
        }
        return runAction(action, { tabToken: token, scope }, urlHint, { orphanClaim: true });
    });
};

const handleAction = async (action: Action) => {
    const urlHint = typeof (action.payload as any)?.url === 'string' ? ((action.payload as any).url as string) : undefined;
    log('action.inbound', {
        id: action.id,
        type: action.type,
        tabToken: action.tabToken || action.scope?.tabToken || null,
        scope: action.scope || null,
        urlHint: urlHint || null,
    });
    if (action.type === ACTION_TYPES.TAB_REPORTED) {
        logTabReportDebug('agent.inbound', {
            id: action.id,
            tabToken: action.tabToken || action.scope?.tabToken || null,
            scope: action.scope || null,
            urlHint: urlHint || null,
        });
    }

    try {
        const target = resolveActionTarget(action, pageRegistry);
        if (target) {
            return runAction(action, target, urlHint);
        }
        if (PAGELESS_ACTIONS.has(action.type)) {
            return runPagelessAction(action);
        }
        return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing action target');
    } catch (error) {
        if (!(error instanceof ActionTargetError)) throw error;

        log('action.target.error', {
            id: action.id,
            type: action.type,
            code: error.code,
            message: error.message,
            scope: action.scope || null,
            tabToken: action.tabToken || action.scope?.tabToken || null,
        });

        if (PAGELESS_ACTIONS.has(action.type)) {
            return runPagelessAction(action);
        }

        if (error.message === 'workspace scope not found for tabToken') {
            const orphanResult = await handleOrphanTokenAction(action, urlHint);
            if (orphanResult) return orphanResult as any;
        }

        return makeErr(error.code, error.message);
    }
};

const isMutatingAction = (type: string) =>
    type === ACTION_TYPES.WORKSPACE_CREATE ||
    type === ACTION_TYPES.WORKSPACE_RESTORE ||
    type === ACTION_TYPES.WORKSPACE_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CREATE ||
    type === ACTION_TYPES.TAB_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CLOSE ||
    type === ACTION_TYPES.TAB_CLOSED ||
    type === ACTION_TYPES.TAB_REASSIGN;

const parseInboundAction = (raw: unknown): Action => {
    if (!raw || typeof raw !== 'object') {
        throw new Error('invalid action: not an object');
    }
    const rec = raw as Record<string, unknown>;
    if (rec.v !== 1 || typeof rec.id !== 'string' || typeof rec.type !== 'string' || !rec.id) {
        throw new Error('invalid action: missing or invalid fields');
    }
    if (!isActionType(rec.type)) {
        throw new Error(`invalid action: unsupported type '${String(rec.type)}'`);
    }
    return rec as Action;
};

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

wss.on('listening', () => {
    log(`WS listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.on('message', (data) => {
        let raw: any;
        try {
            raw = JSON.parse(data.toString());
        } catch {
            socket.send(JSON.stringify({ type: 'error', payload: makeErr('ERR_BAD_JSON', 'invalid json') }));
            return;
        }

        (async () => {
            try {
                if (raw?.cmd || raw?.type === 'cmd') {
                    socket.send(
                        JSON.stringify({
                            type: 'error',
                            replyTo: raw?.id,
                            payload: makeErr(ERROR_CODES.ERR_UNSUPPORTED, 'legacy cmd not supported'),
                        }),
                    );
                    return;
                }

                const action = parseInboundAction(raw);
                const response = await handleAction(action);
                if (action.type === ACTION_TYPES.TAB_REPORTED) {
                    logTabReportDebug('agent.reply', {
                        id: action.id,
                        ok: response.ok,
                        workspaceId: (response as any)?.data?.workspaceId || null,
                        tabId: (response as any)?.data?.tabId || null,
                        tabToken: (response as any)?.data?.tabToken || action.tabToken || action.scope?.tabToken || null,
                    });
                }

                socket.send(
                    JSON.stringify({
                        type: response.ok ? `${action.type}.result` : 'error',
                        replyTo: action.id,
                        payload: response,
                    }),
                );

                if (response.ok && isMutatingAction(action.type)) {
                    const data = response.data as any;
                    broadcast({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: ACTION_TYPES.WORKSPACE_CHANGED,
                        payload: { workspaceId: data?.workspaceId, tabId: data?.tabId, sourceType: action.type },
                        scope: data?.workspaceId
                            ? { workspaceId: String(data.workspaceId), ...(data?.tabId ? { tabId: String(data.tabId) } : {}) }
                            : {},
                        at: Date.now(),
                    });
                }
                if (response.ok && REPORT_STATE_SYNC_ACTIONS.has(action.type)) {
                    const data = response.data as any;
                    if (action.type === ACTION_TYPES.TAB_REPORTED) {
                        logTabReportDebug('agent.emit.state_sync', {
                            id: action.id,
                            reason: `report:${action.type}`,
                            workspaceId: data?.workspaceId || action.scope?.workspaceId || null,
                            tabToken: data?.tabToken || action.tabToken || action.scope?.tabToken || null,
                        });
                    }
                    broadcastStateSync(`report:${action.type}`, {
                        workspaceId: data?.workspaceId || action.scope?.workspaceId || null,
                        tabToken: data?.tabToken || action.tabToken || action.scope?.tabToken || null,
                    });
                    broadcastWorkspaceList(`report:${action.type}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                socket.send(JSON.stringify({ type: 'error', payload: makeErr(ERROR_CODES.ERR_BAD_ARGS, message) }));
            } finally {
                void recordingPersistence.flush();
            }
        })();
    });
    socket.on('close', () => wsClients.delete(socket));
});

setInterval(() => {
    const staleTabs = pageRegistry.listTimedOutTokens(TAB_PING_TIMEOUT_MS, Date.now());
    for (const stale of staleTabs) {
        if (staleNotifiedTokens.has(stale.tabToken)) continue;
        staleNotifiedTokens.add(stale.tabToken);
        broadcastStateSync('ping-timeout', {
            workspaceId: stale.workspaceId,
            tabId: stale.tabId,
            tabToken: stale.tabToken,
            lastSeenAt: stale.lastSeenAt,
        });
        void pageRegistry.closeTokenPage(stale.tabToken);
    }
}, TAB_PING_WATCHDOG_INTERVAL_MS);

(async () => {
    try {
        await contextManager.getContext();
        log('Playwright Chromium launched with extension.');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log('Failed to launch Playwright Chromium:', message);
    }
})();
