import crypto from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { failedAction, isFailedAction, type Action } from './action_protocol';
import { ERROR_CODES } from './results';
import { isRequestActionType, ACTION_TYPES } from './action_types';
import type { WorkspaceRegistry } from '../runtime/workspace/registry';

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
    close: () => Promise<void>;
};

const DEFAULT_HOST = '127.0.0.1';

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
        payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload as Record<string, unknown>).slice(0, 12) : [],
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
    if (!isRequestActionType(rec.type)) {
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
    type === ACTION_TYPES.WORKSPACE_RESTORE ||
    type === ACTION_TYPES.WORKSPACE_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CREATE ||
    type === ACTION_TYPES.TAB_SET_ACTIVE ||
    type === ACTION_TYPES.TAB_CLOSE ||
    type === ACTION_TYPES.TAB_CLOSED ||
    type === ACTION_TYPES.TAB_REASSIGN;

const REPORT_STATE_SYNC_ACTIONS = new Set<string>([
    ACTION_TYPES.WORKSPACE_CREATE,
    ACTION_TYPES.WORKSPACE_RESTORE,
    ACTION_TYPES.TAB_CREATE,
    ACTION_TYPES.TAB_OPENED,
    ACTION_TYPES.TAB_REPORTED,
    ACTION_TYPES.TAB_CLOSED,
    ACTION_TYPES.TAB_REASSIGN,
]);

const createWorkspaceListAction = (workspaceRegistry: WorkspaceRegistry, reason: string): Action => {
    const active = workspaceRegistry.getActiveWorkspace();
    const workspaces = workspaceRegistry.listWorkspaces().map((workspace) => ({
        workspaceName: workspace.name,
        activeTabName: workspace.tabRegistry.getActiveTab()?.name ?? null,
        tabCount: workspace.tabRegistry.listTabs().length,
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
            payload: { workspaceName: workspaceName, tabName: tabName, sourceType: action.type },
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

    const wss = new WebSocketServer({ host, port: options.port });

    wss.on('listening', () => {
        options.onListening?.(`ws://${host}:${options.port}`);
    });

    wss.on('connection', (socket) => {
        wsClients.add(socket);
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

    const close = async () => {
        wsClients.forEach((client) => {
            try { client.close(); } catch { /* ignore */ }
        });
        await new Promise<void>((resolve) => {
            wss.close(() => resolve());
        });
    };

    return { broadcastAction, close };
};
