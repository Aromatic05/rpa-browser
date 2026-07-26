/**
 * WS 客户端封装：维护与 agent 的长连接，发送命令并接收 Action 广播。
 */

import type { Action } from './action_protocol.js';
import { classifyActionType, isDispatchActionType } from './action_types.js';
import { createLogger, type Logger } from '../shared/logger.js';

export type WsClient = {
    connect: () => Promise<void>;
    reconnect: (wsPort: number) => Promise<void>;
    sendAction: (action: Action) => Promise<Action>;
    sendFireAndForget: (action: Action) => void;
};

export type WsClientOptions = {
    onAction: (action: Action) => void;
    wsPort: number;
    logger?: Logger;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

export const createWsClient = (options: WsClientOptions): WsClient => {
    const log = options.logger ?? createLogger('sw');
    const wsTap = (stage: string, data: Record<string, unknown>) => {
        log.warning('[RPA:ws.tap]', { ts: Date.now(), stage, ...data });
    };
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
    let currentWsPort = options.wsPort;
    let wsRef: WebSocket | null = null;
    let wsReady: Promise<void> | null = null;
    const pending = new Map<string, (reply: Action) => void>();

    const mkFailedReply = (requestId: string, code: string, message: string): Action => ({
        v: 1,
        id: crypto.randomUUID(),
        type: 'action.transport.failed',
        payload: { code, message },
        at: Date.now(),
        replyTo: requestId,
    });

    const connect = () => {
        if (wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) {
            return wsReady ?? Promise.resolve();
        }
        const socket = new WebSocket(`ws://127.0.0.1:${String(currentWsPort)}`);
        wsRef = socket;
        wsReady = new Promise((resolve, reject) => {
            let settled = false;
            const settleResolve = () => {
                if (settled) {return;}
                settled = true;
                resolve();
            };
            const settleReject = (message: string) => {
                if (settled) {return;}
                settled = true;
                reject(new Error(message));
            };
            const timeoutId = setTimeout(() => {
                settleReject('ws connect timeout');
            }, 4000);
            socket.addEventListener('open', () => {
                clearTimeout(timeoutId);
                settleResolve();
            });
            socket.addEventListener('error', () => {
                clearTimeout(timeoutId);
                settleReject('ws connect error');
            });
            socket.addEventListener('close', () => {
                clearTimeout(timeoutId);
                settleReject('ws closed before open');
            });
        });
        socket.addEventListener('message', (event) => {
            let payload: unknown = event.data;
            if (typeof payload === 'string') {
                const rawText = payload;
                try {
                    wsTap('ext.inbound.raw', { bytes: rawText.length, preview: rawText.slice(0, 300) });
                    payload = JSON.parse(rawText);
                } catch {
                    wsTap('ext.inbound.parse_failed', { bytes: rawText.length, preview: rawText.slice(0, 300) });
                    return;
                }
            }
            if (!isRecord(payload) || payload.v !== 1 || typeof payload.id !== 'string' || typeof payload.type !== 'string') {
                return;
            }
            const action = payload as Action;
            wsTap('ext.inbound.parsed', summarizeActionEnvelope(action));
            const kind = classifyActionType(action.type);
            if (kind === 'reply' && action.replyTo) {
                const resolver = pending.get(action.replyTo);
                if (resolver) {
                    pending.delete(action.replyTo);
                    resolver(action);
                    return;
                }
            }
            if (kind !== 'reply' && isDispatchActionType(action.type)) {
                options.onAction(action);
            }
        });
        socket.addEventListener('close', () => {
            if (wsRef !== socket) {return;}
            wsRef = null;
            wsReady = null;
            pending.forEach((resolver, requestId) => { resolver(mkFailedReply(requestId, 'ERR_CLOSED', 'ws closed')); });
            pending.clear();
        });
        socket.addEventListener('error', () => {
            log.warning('ws error');
        });
        return wsReady;
    };

    const reconnect = async (wsPort: number) => {
        if (!Number.isInteger(wsPort) || wsPort <= 0) {
            throw new Error(`invalid ws port: ${String(wsPort)}`);
        }
        if (currentWsPort === wsPort && wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) {
            await connect(); return;
        }
        const previous = wsRef;
        wsRef = null;
        wsReady = null;
        pending.forEach((resolver, requestId) => { resolver(mkFailedReply(requestId, 'ERR_RECONNECT', 'ws reconfigured')); });
        pending.clear();
        currentWsPort = wsPort;
        try {
            previous?.close();
        } catch {
            // The old socket may already be closed while reconfiguring.
        }
        await connect();
    };

    const sendAction = (action: Action) => {
        const requestId = action.id;
        return new Promise<Action>((resolve) => {
            const timeoutId = setTimeout(() => {
                pending.delete(requestId);
                resolve(mkFailedReply(requestId, 'ERR_TIMEOUT', 'ws timeout'));
            }, 20000);
            pending.set(requestId, (reply) => {
                clearTimeout(timeoutId);
                resolve(reply);
            });
            connect()
                .then(() => {
                    wsTap('ext.outbound.send', summarizeActionEnvelope(action));
                    wsRef?.send(JSON.stringify(action));
                })
                .catch(() => {
                    clearTimeout(timeoutId);
                    pending.delete(requestId);
                    resolve(mkFailedReply(requestId, 'ERR_CONNECT', 'ws connect failed'));
                });
        });
    };

    const sendFireAndForget = (action: Action) => {
        connect()
            .then(() => {
                wsRef?.send(JSON.stringify(action));
            })
            .catch(() => {
                // silently drop — log forwarding doesn't retry
            });
    };

    return { connect, reconnect, sendAction, sendFireAndForget };
};
