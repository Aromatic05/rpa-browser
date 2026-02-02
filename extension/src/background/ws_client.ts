/**
 * WS 客户端封装：维护与 agent 的长连接，发送命令并接收事件。
 *
 * 设计说明：
 * - 仅处理“连接/重连/超时/事件分发”，不做业务逻辑。
 * - 业务层通过 onEvent 接收 agent 广播事件。
 */

import type { Action, ActionErr, ActionOk, WsActionReply, WsEventPayload } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

export type WsClient = {
    sendAction: (action: Action) => Promise<ActionOk<any> | ActionErr>;
};

export type WsClientOptions = {
    onEvent: (payload: WsEventPayload) => void;
    logger?: (...args: unknown[]) => void;
};

export const createWsClient = (options: WsClientOptions): WsClient => {
    const log = options.logger || createLogger('sw');
    let wsRef: WebSocket | null = null;
    let wsReady: Promise<void> | null = null;
    const pending = new Map<string, (payload: ActionOk<any> | ActionErr) => void>();

    const connect = () => {
        if (wsRef && (wsRef.readyState === WebSocket.OPEN || wsRef.readyState === WebSocket.CONNECTING)) {
            return wsReady || Promise.resolve();
        }
        wsRef = new WebSocket('ws://127.0.0.1:17333');
        wsReady = new Promise((resolve) => {
            wsRef?.addEventListener('open', () => resolve());
        });
        wsRef.addEventListener('message', (event) => {
            let payload: any = event.data;
            if (typeof payload === 'string') {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    return;
                }
            }
            if (payload?.type === 'event') {
                options.onEvent(payload as WsEventPayload);
                return;
            }
            if (payload?.replyTo) {
                const resolver = pending.get(payload.replyTo as string);
                if (!resolver) return;
                pending.delete(payload.replyTo as string);
                resolver((payload as WsActionReply).payload as ActionOk<any> | ActionErr);
            }
        });
        wsRef.addEventListener('close', () => {
            wsRef = null;
            wsReady = null;
            pending.forEach((resolver) => resolver({ ok: false, error: { code: 'ERR_CLOSED', message: 'ws closed' } }));
            pending.clear();
        });
        wsRef.addEventListener('error', () => {
            log('ws error');
        });
        return wsReady;
    };

    const sendAction = (action: Action) => {
        const requestId = action.id;
        return new Promise<ActionOk<any> | ActionErr>((resolve) => {
            const timeoutId = setTimeout(() => {
                pending.delete(requestId);
                resolve({ ok: false, error: { code: 'ERR_TIMEOUT', message: 'ws timeout' } });
            }, 20000);
            pending.set(requestId, (payload) => {
                clearTimeout(timeoutId);
                resolve(payload);
            });
            connect()
                .then(() => {
                    wsRef?.send(JSON.stringify(action));
                })
                .catch(() => {
                    clearTimeout(timeoutId);
                    pending.delete(requestId);
                    resolve({ ok: false, error: { code: 'ERR_CONNECT', message: 'ws connect failed' } });
                });
        });
    };

    return { sendAction };
};
