/**
 * WS 客户端封装：维护与 agent 的长连接，发送命令并接收 Action 广播。
 */

import type { Action } from '../shared/types.js';
import { classifyActionType, isDispatchActionType } from './action_types.js';
import { createLogger, type Logger } from '../shared/logger.js';

export type WsClient = {
    sendAction: (action: Action) => Promise<Action>;
};

export type WsClientOptions = {
    onAction: (action: Action) => void;
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
            payloadKeys: payload && typeof payload === 'object' ? Object.keys(payload as Record<string, unknown>).slice(0, 12) : [],
        };
    };
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
        wsRef = new WebSocket('ws://127.0.0.1:17333');
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
            wsRef?.addEventListener('open', () => {
                clearTimeout(timeoutId);
                settleResolve();
            });
            wsRef?.addEventListener('error', () => {
                clearTimeout(timeoutId);
                settleReject('ws connect error');
            });
            wsRef?.addEventListener('close', () => {
                clearTimeout(timeoutId);
                settleReject('ws closed before open');
            });
        });
        wsRef.addEventListener('message', (event) => {
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
        wsRef.addEventListener('close', () => {
            wsRef = null;
            wsReady = null;
            pending.forEach((resolver, requestId) => { resolver(mkFailedReply(requestId, 'ERR_CLOSED', 'ws closed')); });
            pending.clear();
        });
        wsRef.addEventListener('error', () => {
            log.warning('ws error');
        });
        return wsReady;
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

    return { sendAction };
};
