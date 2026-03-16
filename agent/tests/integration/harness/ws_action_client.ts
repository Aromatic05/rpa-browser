import { WebSocket } from 'ws';
import crypto from 'node:crypto';
import type { ActionErr, ActionOk, ActionPayload, IntegrationClient } from './types';

export const createWsActionClient = async (url = 'ws://127.0.0.1:17333'): Promise<IntegrationClient> => {
    const ws = new WebSocket(url);

    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('ws connect timeout')), 10000);
        ws.on('open', () => {
            clearTimeout(timeout);
            resolve();
        });
        ws.on('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });
    });

    const pending = new Map<string, (payload: ActionOk<any> | ActionErr) => void>();
    const eventWaiters = new Map<string, Array<(data: Record<string, unknown>) => void>>();
    const lastEvents = new Map<string, Record<string, unknown>>();
    ws.on('message', (raw) => {
        try {
            const packet = JSON.parse(String(raw));
            if (packet?.type === 'event' && typeof packet?.event === 'string') {
                const data = (packet.data || {}) as Record<string, unknown>;
                lastEvents.set(packet.event as string, data);
                const waiters = eventWaiters.get(packet.event as string);
                if (waiters?.length) {
                    eventWaiters.delete(packet.event as string);
                    for (const waiter of waiters) waiter(data);
                }
                return;
            }
            const replyTo = packet?.replyTo as string | undefined;
            const payload = packet?.payload as ActionOk<any> | ActionErr | undefined;
            if (!replyTo || !payload) return;
            const resolver = pending.get(replyTo);
            if (!resolver) return;
            pending.delete(replyTo);
            resolver(payload);
        } catch {
            // ignore non-json packet
        }
    });

    const sendAction: IntegrationClient['sendAction'] = (action) => {
        const full: ActionPayload = {
            v: 1,
            id: action.id || crypto.randomUUID(),
            type: action.type,
            tabToken: action.tabToken,
            scope: action.scope,
            payload: action.payload,
        };
        return new Promise<ActionOk<any> | ActionErr>((resolve) => {
            const timeout = setTimeout(() => {
                pending.delete(full.id);
                resolve({ ok: false, error: { code: 'ERR_TIMEOUT', message: 'action timeout' } });
            }, 20000);
            pending.set(full.id, (payload) => {
                clearTimeout(timeout);
                resolve(payload);
            });
            ws.send(JSON.stringify(full));
        });
    };

    return {
        sendAction,
        waitForEvent: async (event, timeoutMs = 20000) =>
            new Promise<Record<string, unknown>>((resolve, reject) => {
                const cached = lastEvents.get(event);
                if (cached) {
                    resolve(cached);
                    return;
                }
                const timeout = setTimeout(() => {
                    reject(new Error(`event timeout: ${event}`));
                }, timeoutMs);
                const waiters = eventWaiters.get(event) || [];
                waiters.push((data) => {
                    clearTimeout(timeout);
                    resolve(data);
                });
                eventWaiters.set(event, waiters);
            }),
        close: async () => {
            if (ws.readyState === WebSocket.CLOSED) return;
            await new Promise<void>((resolve) => {
                const timer = setTimeout(() => resolve(), 2000);
                ws.once('close', () => resolve());
                ws.close();
                ws.once('error', () => resolve());
                ws.once('close', () => clearTimeout(timer));
            });
        },
    };
};
