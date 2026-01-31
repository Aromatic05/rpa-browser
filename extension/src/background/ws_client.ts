/**
 * WS 客户端封装：维护与 agent 的长连接，发送命令并接收事件。
 *
 * 设计说明：
 * - 仅处理“连接/重连/超时/事件分发”，不做业务逻辑。
 * - 业务层通过 onEvent 接收 agent 广播事件。
 */

import type { WsEventPayload, WsResultPayload } from '../shared/types.js';
import { createLogger } from '../shared/logger.js';

export type WsClient = {
    sendCommand: (command: Record<string, unknown>) => Promise<any>;
};

export type WsClientOptions = {
    onEvent: (payload: WsEventPayload) => void;
    logger?: (...args: unknown[]) => void;
};

export const createWsClient = (options: WsClientOptions): WsClient => {
    const log = options.logger || createLogger('sw');
    let wsRef: WebSocket | null = null;
    let wsReady: Promise<void> | null = null;
    const pending = new Map<string, (payload: any) => void>();

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
            if (payload?.type === 'result' && payload.requestId) {
                const resolver = pending.get(payload.requestId);
                if (resolver) {
                    pending.delete(payload.requestId);
                    resolver((payload as WsResultPayload).payload);
                }
            }
        });
        wsRef.addEventListener('close', () => {
            wsRef = null;
            wsReady = null;
            pending.forEach((resolver) => resolver({ ok: false, error: 'ws closed' }));
            pending.clear();
        });
        wsRef.addEventListener('error', () => {
            log('ws error');
        });
        return wsReady;
    };

    const sendCommand = (command: Record<string, unknown>) => {
        const requestId = command.requestId as string;
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                pending.delete(requestId);
                resolve({ ok: false, error: 'ws timeout' });
            }, 20000);
            pending.set(requestId, (payload) => {
                clearTimeout(timeoutId);
                resolve(payload);
            });
            connect()
                .then(() => {
                    wsRef?.send(JSON.stringify({ type: 'cmd', cmd: command }));
                })
                .catch(() => {
                    clearTimeout(timeoutId);
                    pending.delete(requestId);
                    resolve({ ok: false, error: 'ws connect failed' });
                });
        });
    };

    return { sendCommand };
};
