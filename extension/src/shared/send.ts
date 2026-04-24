/**
 * send：消息发送的唯一出口（runtime/tabs）。
 *
 * 设计说明：
 * - 统一处理 MV3 常见错误：lastError / port closed / 超时 / 无接收端。
 * - transport 层返回 TransportResult；业务层（Action）始终只处理 Action。
 */

import { MSG, type TransportError, type TransportResult } from './protocol.js';
import { deriveFailedActionType } from './action_types.js';
import type { Action } from './types.js';

const DEFAULT_TIMEOUT_MS = 20000;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<TransportResult<T>> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return await new Promise((resolve) => {
        timer = setTimeout(() => {
            resolve({ ok: false, error: { code: 'TIMEOUT', message: 'request timeout' } });
        }, ms);
        promise
            .then((value) => { resolve({ ok: true, data: value }); })
            .catch((error) => { resolve({ ok: false, error: normalizeRuntimeError(error) }); })
            .finally(() => {
                if (timer) {clearTimeout(timer);}
            });
    });
};

const normalizeRuntimeError = (error: unknown): TransportError => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('message port closed') || message.includes('Message port closed')) {
        return { code: 'PORT_CLOSED', message };
    }
    if (message.includes('Receiving end does not exist')) {
        return { code: 'NO_RECEIVER', message };
    }
    return { code: 'RUNTIME_ERROR', message };
};

const runtimeTransport = async <T>(req: any, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<TransportResult<T>> => {
    const promise = new Promise<T>((resolve, reject) => {
        chrome.runtime.sendMessage(req, (response: any) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response as T);
        });
    });
    return await withTimeout(promise, timeoutMs);
};

const tabTransport = async <T>(
    tabId: number,
    req: any,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<TransportResult<T>> => {
    const promise = new Promise<T>((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, req, (response: any) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response as T);
        });
    });
    return await withTimeout(promise, timeoutMs);
};

export const send = {
    /**
     * 向 SW 发送 hello（content -> SW）。
     */
    hello: (payload: { tabToken: string; url: string }) =>
        runtimeTransport<{ ok: boolean }>(
            { type: MSG.HELLO, ...payload },
            5000,
        ),

    /**
     * 发送 Action（content/panel -> SW）。
     */
    action: async (action: Action): Promise<Action> => {
        const response = await runtimeTransport<Action>({ type: MSG.ACTION, action });
        if (response.ok && response.data?.v === 1 && typeof response.data.type === 'string') {
            return response.data;
        }
        const transportError = response.ok
            ? { code: 'BAD_REQUEST', message: 'invalid action response shape' }
            : response.error;
        const details =
            'details' in transportError ? (transportError.details as unknown) : undefined;
        return {
            v: 1,
            id: crypto.randomUUID(),
            type: deriveFailedActionType(String(action.type || '')),
            replyTo: String(action.id || ''),
            payload: { code: transportError.code, message: transportError.message, details },
            at: Date.now(),
        } satisfies Action;
    },

    /**
     * 向指定 tab 发送消息（SW -> content）。
     */
    toTabTransport: <T = any>(tabId: number, type: string, payload?: any, opts?: { timeoutMs?: number }) =>
        tabTransport<T>(tabId, { type, ...payload }, opts?.timeoutMs),

};
