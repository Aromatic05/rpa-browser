import crypto from 'node:crypto';
import {createServer} from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { failedAction, isFailedAction, type Action } from './action_protocol';
import { ERROR_CODES } from './results';
import { isRequestActionType, isDerivedEventActionType, ACTION_TYPES } from './action_types';
import type { WorkspaceRegistry } from '../../app/runtime/workspace/registry';

export type ActionWsTap = (stage: string, data: Record<string, unknown>) => void;

export type StartActionWsClientOptions = {
    port: number;
    host?: string;
    workspaceRegistry: WorkspaceRegistry;
    dispatchAction: (action: Action) => Promise<Action>;
    onError: (error: unknown) => void;
    onListening?: (url: string) => void;
    wsTap?: ActionWsTap;
};

export type ActionWsClient = {
    broadcastAction: (action: Action) => void;
    waitForListening: (timeoutMs?: number) => Promise<void>;
    waitForClient: (timeoutMs?: number) => Promise<void>;
    close: () => Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';

const START_PAGE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>RPA Browser</title></head>
<body data-rpa-start-page="true"><main><h1>RPA Browser</h1><p>The extension is connecting to the local agent.</p></main></body>
</html>`;


const summarizeActionEnvelope = (raw: unknown): Record<string, unknown> => {
    if (!raw || typeof raw !== 'object') {
        return { kind: typeof raw, isObject: false };
    }
    const rec = raw as Record<string, unknown>;
    const payload = rec.payload;
    return {
        v: rec.v,
        id: typeof rec.id === 'string' ? rec.id : undefined,
        replyTo: typeof rec.replyTo === 'string' ? rec.replyTo : undefined,
        type: typeof rec.type === 'string' ? rec.type : undefined,
        workspaceName: typeof rec.workspaceName === 'string' ? rec.workspaceName : undefined,
        payloadType: Array.isArray(payload) ? 'array' : typeof payload,
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 12) : [],
    };
};

const parseInboundAction = (raw: unknown): Action => {
    if (!raw || typeof raw !== 'object') {
        throw new Error('invalid action: not an object');
    }
    const rec = raw as Record<string, unknown>;
    if (rec.v !== 1 || typeof rec.id !== 'string' || typeof rec.type !== 'string' || !rec.id) {
        throw new Error('invalid action: missing or invalid fields');
    }
    if ('scope' in rec || 'tabName' in rec) {
        throw new Error('invalid action: legacy address fields are not allowed');
    }
    if (!isRequestActionType(rec.type) && !isDerivedEventActionType(rec.type)) {
        throw new Error(`invalid action: unsupported type '${rec.type}'`);
    }
    return rec as Action;
};

const readMessageText = (data: unknown): string => {
    if (typeof data === 'string') {return data;}
    if (Buffer.isBuffer(data)) {return data.toString('utf8');}
    if (Array.isArray(data)) {return Buffer.concat(data).toString('utf8');}
    if (data instanceof ArrayBuffer) {return Buffer.from(data).toString('utf8');}
    return '';
};

const safeSend = (socket: WebSocket, action: Action) => {
    socket.send(JSON.stringify(action));
};

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord => typeof value === 'object' && value !== null;

const getStringField = (value: UnknownRecord, key: string): string | null =>
    typeof value[key] === 'string' ? value[key] : null;

const isMutatingAction = (type: string) =>
    type === ACTION_TYPES.WORKSPACE_CREATE ||
    type === ACTION_TYPES.WORKSPACE_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CLOSED ||
    type === ACTION_TYPES.TAB_REASSIGNED;

const REPORT_STATE_SYNC_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.TAB_OPENED,
    ACTION_TYPES.TAB_REPORTED,
    ACTION_TYPES.TAB_CLOSE,
    ACTION_TYPES.TAB_CLOSED,
    ACTION_TYPES.TAB_REASSIGNED,
]);

const createWorkspaceListAction = (workspaceRegistry: WorkspaceRegistry, reason: string): Action => {
    const active = workspaceRegistry.getActiveWorkspace();
    const workspaces = workspaceRegistry.listWorkspaces().map((workspace) => ({
        workspaceName: workspace.name,
        activeTabName: workspace.tabs.getActiveTab()?.name ?? null,
        tabCount: workspace.tabs.listTabs().length,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
    }));
    return {
        v: 1,
        id: crypto.randomUUID(),
        type: ACTION_TYPES.WORKSPACE_LIST,
        payload: {
            reason,
            workspaces,
            activeWorkspaceName: active?.name || null,
        },
        at: Date.now(),
    };
};

const createProjectedActions = (workspaceRegistry: WorkspaceRegistry, action: Action, reply: Action): Action[] => {
    if (isFailedAction(reply)) {return [];}
    const projected: Action[] = [];

    const data = isRecord(reply.payload) ? reply.payload : null;
    const workspaceName = data ? getStringField(data, 'workspaceName') : null;
    const tabName = data ? getStringField(data, 'tabName') : null;

    if (isMutatingAction(action.type)) {
        projected.push({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_CHANGED,
            payload: { workspaceName, tabName, sourceType: action.type },
            workspaceName: workspaceName || undefined,
            at: Date.now(),
        });
    }

    if (REPORT_STATE_SYNC_ACTIONS.has(action.type)) {
        const syncWorkspaceName = workspaceName ?? action.workspaceName ?? null;
        projected.push({
            v: 1,
            id: crypto.randomUUID(),
            type: ACTION_TYPES.WORKSPACE_SYNC,
            payload: { reason: `report:${action.type}`, workspaceName: syncWorkspaceName, tabName },
            at: Date.now(),
        });
        projected.push(createWorkspaceListAction(workspaceRegistry, `report:${action.type}`));
    }

    return projected;
};

export const startActionWsClient = (options: StartActionWsClientOptions): ActionWsClient => {
    const wsTap = options.wsTap ?? (() => undefined);
    const host = options.host ?? DEFAULT_HOST;
    const wsClients = new Set<WebSocket>();
    const clientWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let closed = false;
    let listening = false;
    let listeningError: Error | null = null;
    let resolveListening!: () => void;
    let rejectListening!: (error: Error) => void;
    const listeningPromise = new Promise<void>((resolve, reject) => {
        resolveListening = resolve;
        rejectListening = reject;
    });

    const resolveClientWaiters = () => {
        const waiters = Array.from(clientWaiters);
        clientWaiters.clear();
        waiters.forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter.resolve();
        });
    };

    const rejectClientWaiters = (error: Error) => {
        const waiters = Array.from(clientWaiters);
        clientWaiters.clear();
        waiters.forEach((waiter) => {
            clearTimeout(waiter.timer);
            waiter.reject(error);
        });
    };

    const hasOpenClient = () => Array.from(wsClients).some((client) => client.readyState === client.OPEN);

    const sendToAll = (action: Action) => {
        wsTap('agent.broadcast', summarizeActionEnvelope(action));
        const payload = JSON.stringify(action);
        wsClients.forEach((client) => {
            try {
                if (client.readyState === client.OPEN) {client.send(payload);}
            } catch {
                // ignore
            }
        });
    };

    const broadcastAction = (action: Action) => {
        sendToAll(action);
        if (action.type === ACTION_TYPES.WORKSPACE_SYNC) {
            const payload = isRecord(action.payload) ? action.payload : null;
            const reason = payload && typeof payload.reason === 'string' ? payload.reason : 'sync';
            sendToAll(createWorkspaceListAction(options.workspaceRegistry, reason));
        }
    };

    const httpServer = createServer((request, response) => {
        const requestUrl = new URL(request.url ?? '/', `http://${host}:${String(options.port)}`);
        if (request.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/rpa-start')) {
            response.writeHead(200, {
                'content-type': 'text/html; charset=utf-8',
                'cache-control': 'no-store',
            });
            response.end(START_PAGE_HTML);
            return;
        }
        response.writeHead(404, {'content-type': 'text/plain; charset=utf-8'});
        response.end('not found');
    });
    const wss = new WebSocketServer({server: httpServer});

    httpServer.on('listening', () => {
        listening = true;
        resolveListening();
        options.onListening?.(`ws://${host}:${options.port}`);
    });

    const handleServerError = (error: unknown) => {
        const normalized = error instanceof Error ? error : new Error(String(error));
        listeningError = normalized;
        if (!listening) {
            rejectListening(normalized);
        }
        rejectClientWaiters(normalized);
        options.onError(normalized);
    };
    httpServer.on('error', handleServerError);
    wss.on('error', handleServerError);
    httpServer.listen(options.port, host);

    wss.on('connection', (socket) => {
        wsClients.add(socket);
        resolveClientWaiters();
        socket.on('message', (data) => {
            let raw: unknown;
            let rawText = '';
            try {
                rawText = readMessageText(data);
                wsTap('agent.inbound.raw', { bytes: rawText.length, preview: rawText.slice(0, 300) });
                raw = JSON.parse(rawText);
                wsTap('agent.inbound.parsed', summarizeActionEnvelope(raw));
            } catch {
                safeSend(
                    socket,
                    {
                        v: 1,
                        id: crypto.randomUUID(),
                        type: 'action.dispatch.failed',
                        payload: { code: 'ERR_BAD_JSON', message: 'invalid json' },
                        at: Date.now(),
                    } satisfies Action,
                );
                wsTap('agent.inbound.parse_failed', { bytes: rawText.length, preview: rawText.slice(0, 300) });
                return;
            }

            void (async () => {
                try {
                    const action = parseInboundAction(raw);
                    const reply = await options.dispatchAction(action);
                    wsTap('agent.reply', summarizeActionEnvelope(reply));
                    safeSend(socket, reply);

                    const projected = createProjectedActions(options.workspaceRegistry, action, reply);
                    for (const projectedAction of projected) {
                        sendToAll(projectedAction);
                    }
                } catch (error) {
                    options.onError(error);
                    const message = error instanceof Error ? error.message : String(error);
                    safeSend(
                        socket,
                        failedAction(
                            {
                                v: 1,
                                id: crypto.randomUUID(),
                                type: 'action.dispatch',
                                payload: {},
                            },
                            ERROR_CODES.ERR_BAD_ARGS,
                            message,
                            undefined,
                            'action.dispatch.failed',
                        ),
                    );
                }
            })();
        });

        socket.on('close', () => {
            wsClients.delete(socket);
        });
    });

    const waitForListening = async (timeoutMs = 5000) => {
        if (listening) {return;}
        if (listeningError) {throw listeningError;}
        if (closed) {throw new Error('workspace action websocket server closed');}
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                listeningPromise,
                new Promise<void>((_resolve, reject) => {
                    timer = setTimeout(() => { reject(new Error(`workspace action websocket server did not listen within ${timeoutMs}ms`)); }, timeoutMs);
                }),
            ]);
        } finally {
            if (timer) {clearTimeout(timer);}
        }
    };

    const waitForClient = async (timeoutMs = 5000) => {
        if (hasOpenClient()) {return;}
        if (closed) {throw new Error('workspace action websocket server closed');}
        await new Promise<void>((resolve, reject) => {
            const waiter = {
                resolve,
                reject,
                timer: setTimeout(() => {
                    clientWaiters.delete(waiter);
                    reject(new Error(`workspace action websocket client did not connect within ${timeoutMs}ms`));
                }, timeoutMs),
            };
            clientWaiters.add(waiter);
        });
    };

    let closePromise: Promise<void> | null = null;
    const close = async () => {
        if (closePromise) {
            await closePromise;
            return;
        }
        closePromise = (async () => {
            closed = true;
            const closeError = new Error('workspace action websocket server closed');
            if (!listening) {
                rejectListening(closeError);
            }
            rejectClientWaiters(closeError);
            wsClients.forEach((client) => {
                try {client.terminate();} catch { /* ignore */ }
            });
            wsClients.clear();
            await new Promise<void>((resolve) => {
                try {
                    wss.close(() => {resolve();});
                } catch {
                    resolve();
                }
            });
            httpServer.closeAllConnections();
            await new Promise<void>((resolve) => {
                if (!httpServer.listening) {
                    resolve();
                    return;
                }
                httpServer.close(() => {resolve();});
            });
        })();
        await closePromise;
    };

    return {broadcastAction, waitForListening, waitForClient, close};
};
