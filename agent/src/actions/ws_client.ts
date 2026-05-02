import { WebSocketServer, type WebSocket } from 'ws';
import { failedAction, type Action } from './action_protocol';
import { ERROR_CODES } from './error_codes';
import { isRequestActionType } from './action_types';

export type ActionWsTap = (stage: string, data: Record<string, unknown>) => void;

export type StartActionWsClientOptions = {
    port: number;
    host?: string;
    dispatchAction: (action: Action) => Promise<Action>;
    projectActionResult: (action: Action, reply: Action) => Action[];
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

export const startActionWsClient = (options: StartActionWsClientOptions): ActionWsClient => {
    const wsTap = options.wsTap ?? (() => undefined);
    const host = options.host ?? DEFAULT_HOST;
    const wsClients = new Set<WebSocket>();

    const broadcastAction = (action: Action) => {
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

                    const projected = options.projectActionResult(action, reply);
                    for (const projectedAction of projected) {
                        broadcastAction(projectedAction);
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
