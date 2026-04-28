import path from 'node:path';
import assert from 'node:assert/strict';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Page } from 'playwright';
import { createContextManager, resolvePaths } from './runtime/context_manager';
import { createPageRegistry } from './runtime/page_registry';
import { createRuntimeRegistry } from './runtime/runtime_registry';
import { createRecordingState, cleanupRecording, ensureRecorder, setRecorderEventSink } from './record/recording';
import { loadRecordingStateFromFile, startRecordingStateAutoSave } from './record/persistence';
import { executeAction, type ActionContext } from './actions/execute';
import { failedAction, isFailedAction, type Action } from './actions/action_protocol';
import { replyAction } from './actions/action_protocol';
import { ERROR_CODES } from './actions/error_codes';
import { createRunnerScopeRegistry } from './runner/runner_scope';
import { createConsoleStepSink, setRunStepsDeps } from './runner/run_steps';
import { getRunnerConfig } from './config';
import { FileSink, createLoggingHooks, createNoopHooks } from './runner/trace';
import { initLogger, getLogger, resolveLogPath } from './logging/logger';
import { RunnerPluginHost } from './runner/hotreload/plugin_host';
import { resolveActionTarget, ActionTargetError } from './runtime/action_target';
import { ACTION_TYPES, isRequestActionType } from './actions/action_types';
import { createActionDispatcher } from './actions/dispatcher';
import { createControlServer, registerControlShutdown, setControlActionDispatcher } from './control';

const TAB_TOKEN_KEY = '__rpa_tab_token';
const WS_PORT = Number(process.env.RPA_WS_PORT || 17333);
const PAGELESS_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_LIST,
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.RECORD_LIST,
    ACTION_TYPES.TAB_INIT,
    ACTION_TYPES.WORKFLOW_LIST,
    ACTION_TYPES.WORKFLOW_OPEN,
    ACTION_TYPES.WORKFLOW_STATUS,
    ACTION_TYPES.WORKFLOW_RECORD_SAVE,
    ACTION_TYPES.WORKFLOW_DSL_GET,
    ACTION_TYPES.WORKFLOW_DSL_SAVE,
    ACTION_TYPES.WORKFLOW_DSL_TEST,
    ACTION_TYPES.WORKFLOW_RELEASE_RUN,
    ACTION_TYPES.WORKFLOW_INIT,
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
const log = (...args: unknown[]) => { actionLog.info('[RPA:agent]', ...args); };
const logWarning = (...args: unknown[]) => { actionLog.warning('[RPA:agent]', ...args); };
const logError = (...args: unknown[]) => { actionLog.error('[RPA:agent]', ...args); };
const logTabReportDebug = (stage: string, data: Record<string, unknown>) =>
    { actionLog.debug('[RPA:tab.report]', { ts: Date.now(), stage, ...data }); };

const paths = resolvePaths();
const recordingState = createRecordingState();
const recordingStatePath = path.resolve(paths.userDataDir, 'recordings.state.json');
await loadRecordingStateFromFile(recordingState, recordingStatePath);
const recordingPersistence = startRecordingStateAutoSave(recordingState, recordingStatePath, {
    intervalMs: 1500,
    onError: (error) => { actionLog.error('[RPA:agent]', 'recording persistence error', String(error)); },
});

const contextManager = createContextManager({
    extensionPaths: paths.extensionPaths,
    userDataDir: paths.userDataDir,
    onPage: (page) => {
        void pageRegistry.bindPage(page);
    },
});

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
            if (client.readyState === client.OPEN) {client.send(payload);}
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
type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
    typeof value === 'object' && value !== null;

const getStringField = (value: UnknownRecord, key: string): string | null =>
    typeof value[key] === 'string' ? value[key] : null;

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
    const active = pageRegistry.getActiveWorkspace();
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
        try {
            runtimeRegistry.bindPage(page, token);
        } catch {
            // runtime trace binding is best-effort during early token/workspace races
        }
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
    onTokenClosed: (token) => { cleanupRecording(recordingState, token); },
});

const runnerScope = createRunnerScopeRegistry(2);
const runtimeRegistry: ReturnType<typeof createRuntimeRegistry> = createRuntimeRegistry({
    pageRegistry,
    traceSinks,
    traceHooks: config.observability.traceConsoleEnabled ? createLoggingHooks() : createNoopHooks(),
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
        runtime: runtimeRegistry,
        recordingState,
        log: actionLogger,
        replayOptions: REPLAY_OPTIONS,
        navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        emit: broadcast,
        runStepsDeps,
    }),
);
const controlServer = createControlServer({ deps: runStepsDeps });
registerControlShutdown(controlServer, log);

const createActionContext = (page: Page, tabToken: string): ActionContext => {
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry,
        log: actionLogger,
        recordingState,
        replayOptions: REPLAY_OPTIONS,
        navDedupeWindowMs: NAV_DEDUPE_WINDOW_MS,
        emit: broadcast,
        runStepsDeps,
        execute: undefined,
    };
    ctx.execute = (innerAction: Action) => executeAction(ctx, innerAction);
    return ctx;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const retryClaim = async <T>(fn: () => T | null, attempts = 10, intervalMs = 60): Promise<T | null> => {
    for (let i = 0; i < attempts; i += 1) {
        const result = fn();
        if (result) {return result;}
        if (i < attempts - 1) {await sleep(intervalMs);}
    }
    return null;
};

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
    return await runnerScope.run(target.scope.workspaceId, async () => {
        actionLogger('action', { type: action.type, tabToken: target.tabToken, id: action.id, ...(extra || {}) });
        return await executeAction(createActionContext(page, target.tabToken), action);
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
    ) as unknown as Page;
    actionLogger('action', { type: action.type, tabToken: tabToken || null, id: action.id, mode: 'pageless' });
    return await executeAction(createActionContext(pageStub, tabToken), action);
};

const bindTabOpenedAction = async (action: Action, urlHint?: string) => {
    const token =
        typeof action.scope?.tabToken === 'string'
            ? action.scope.tabToken
            : typeof action.tabToken === 'string'
              ? action.tabToken
              : '';
    if (!token) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'tab.opened missing tabToken');}
    const payload = (action.payload || {}) as Record<string, unknown>;
    const workspaceId =
        (typeof payload.workspaceId === 'string' ? payload.workspaceId : '') ||
        (typeof action.scope?.workspaceId === 'string' ? action.scope.workspaceId : '');
    if (!workspaceId) {return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'tab.opened requires workspaceId');}
    pageRegistry.createPendingTokenClaim({
        tabToken: token,
        workspaceId,
        source: typeof payload.source === 'string' ? payload.source : 'tab.opened',
        url: typeof payload.url === 'string' ? payload.url : urlHint,
        createdAt: typeof payload.at === 'number' ? payload.at : Date.now(),
    });
    await pageRegistry.claimPendingToken(token);
    const scoped = await retryClaim(() => pageRegistry.bindTokenToWorkspace(token, workspaceId), 80, 50);
    if (!scoped) {
        logWarning('tab.opened.defer_claim', {
            tabToken: token,
            workspaceId,
            source: typeof payload.source === 'string' ? payload.source : 'tab.opened',
            url: typeof payload.url === 'string' ? payload.url : urlHint || null,
        });
        return replyAction(action, {
            workspaceId,
            tabId: null,
            tabToken: token,
            deferred: true,
        });
    }
    return await runAction(action, { tabToken: token, scope: scoped }, urlHint, { byWindow: true });
};

const handleAction = async (action: Action) => {
    const payload = isRecord(action.payload) ? action.payload : null;
    const urlHint = payload && typeof payload.url === 'string' ? payload.url : undefined;
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

    if (action.type === ACTION_TYPES.TAB_OPENED) {
        return await bindTabOpenedAction(action, urlHint);
    }

    try {
        const target = resolveActionTarget(action, pageRegistry);
        if (target) {
            return runAction(action, target, urlHint);
        }
        if (PAGELESS_ACTIONS.has(action.type)) {
            return runPagelessAction(action);
        }
        return failedAction(action, ERROR_CODES.ERR_BAD_ARGS, 'missing action target');
    } catch (error) {
        if (!(error instanceof ActionTargetError)) {throw error;}

        logWarning('action.target.error', {
            id: action.id,
            type: action.type,
            code: error.code,
            message: error.message,
            scope: action.scope || null,
            tabToken: action.tabToken || action.scope?.tabToken || null,
        });

        if (PAGELESS_ACTIONS.has(action.type)) {
            return await runPagelessAction(action);
        }

        return failedAction(action, error.code, error.message);
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
    if (!isRequestActionType(rec.type)) {
        throw new Error(`invalid action: unsupported type '${rec.type}'`);
    }
    return rec as Action;
};

setRecorderEventSink(async (event, page, tabToken) => {
    let scope: { workspaceId?: string; tabId?: string; tabToken?: string } | undefined;
    try {
        const resolved = pageRegistry.resolveScopeFromToken(tabToken);
        scope = { workspaceId: resolved.workspaceId, tabId: resolved.tabId, tabToken };
    } catch {
        scope = { tabToken };
    }
    const action: Action = {
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.RECORD_EVENT,
        tabToken,
        scope,
        payload: event,
        at: event.ts || Date.now(),
    };
    broadcast(action);
    const response = await executeAction(createActionContext(page, tabToken), action);
    if (isFailedAction(response)) {
        logWarning('record.event.ingest.failed', { tabToken, error: response.payload });
    }
});

const wss = new WebSocketServer({ host: '127.0.0.1', port: WS_PORT });

wss.on('listening', () => {
    log(`WS listening on ws://127.0.0.1:${WS_PORT}`);
});

wss.on('connection', (socket) => {
    wsClients.add(socket);
    socket.on('message', (data) => {
        let raw: unknown;
        try {
            const rawText =
                typeof data === 'string'
                    ? data
                    : Buffer.isBuffer(data)
                      ? data.toString('utf8')
                      : Array.isArray(data)
                        ? Buffer.concat(data).toString('utf8')
                        : data instanceof ArrayBuffer
                          ? Buffer.from(data).toString('utf8')
                          : '';
            raw = JSON.parse(rawText);
        } catch {
            socket.send(
                JSON.stringify({
                    v: 1,
                    id: crypto.randomUUID(),
                    type: 'action.dispatch.failed',
                    payload: { code: 'ERR_BAD_JSON', message: 'invalid json' },
                    at: Date.now(),
                } satisfies Action),
            );
            return;
        }

        void (async () => {
            try {
                const action = parseInboundAction(raw);
                const response = await handleAction(action);
                if (action.type === ACTION_TYPES.TAB_REPORTED) {
                    const responsePayload = isRecord(response.payload) ? response.payload : null;
                    logTabReportDebug('agent.reply', {
                        id: action.id,
                        ok: !isFailedAction(response),
                        workspaceId: responsePayload ? getStringField(responsePayload, 'workspaceId') : null,
                        tabId: responsePayload ? getStringField(responsePayload, 'tabId') : null,
                        tabToken:
                            (responsePayload ? getStringField(responsePayload, 'tabToken') : null) ??
                            action.tabToken ??
                            action.scope?.tabToken ??
                            null,
                    });
                }
                socket.send(JSON.stringify(response));

                if (!isFailedAction(response) && isMutatingAction(action.type)) {
                    const data = isRecord(response.payload) ? response.payload : null;
                    const workspaceId = data ? getStringField(data, 'workspaceId') : null;
                    const tabId = data ? getStringField(data, 'tabId') : null;
                    broadcast({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: ACTION_TYPES.WORKSPACE_CHANGED,
                        payload: { workspaceId, tabId, sourceType: action.type },
                        scope: workspaceId
                            ? { workspaceId, ...(tabId ? { tabId } : {}) }
                            : {},
                        at: Date.now(),
                    });
                }
                if (!isFailedAction(response) && REPORT_STATE_SYNC_ACTIONS.has(action.type)) {
                    const data = isRecord(response.payload) ? response.payload : null;
                    const workspaceId = (data ? getStringField(data, 'workspaceId') : null) ?? action.scope?.workspaceId ?? null;
                    const tabToken = (data ? getStringField(data, 'tabToken') : null) ?? action.tabToken ?? action.scope?.tabToken ?? null;
                    if (action.type === ACTION_TYPES.TAB_REPORTED) {
                        logTabReportDebug('agent.emit.state_sync', {
                            id: action.id,
                            reason: `report:${action.type}`,
                            workspaceId,
                            tabToken,
                        });
                    }
                    broadcastStateSync(`report:${action.type}`, {
                        workspaceId,
                        tabToken,
                    });
                    broadcastWorkspaceList(`report:${action.type}`);
                }
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logError('action.dispatch.failed', { message });
                socket.send(
                    JSON.stringify({
                        v: 1,
                        id: crypto.randomUUID(),
                        type: 'action.dispatch.failed',
                        payload: { code: ERROR_CODES.ERR_BAD_ARGS, message },
                        at: Date.now(),
                    } satisfies Action),
                );
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
        if (staleNotifiedTokens.has(stale.tabToken)) {continue;}
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
    await contextManager.getContext();
    await controlServer.start();
    if (pageRegistry.listWorkspaces().length === 0) {
        const created = pageRegistry.createWorkspaceShell();
        assert.ok(created.workspaceId, 'bootstrap workspaceId missing');
        log('workspace.bootstrap.created', { workspaceId: created.workspaceId });
    }
    broadcastWorkspaceList('bootstrap');
    log(`Control RPC listening on ${controlServer.endpoint}`);
    log('Playwright Chromium launched with extension.');
})().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    logError('Fatal startup error:', message);
    throw error;
});
