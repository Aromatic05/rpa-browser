/**
 * send：消息发送的唯一出口（runtime/tabs）。
 *
 * 设计说明：
 * - 统一处理 MV3 常见错误：lastError / port closed / 超时 / 无接收端。
 * - 对外返回 RpcResult，业务侧只需判断 ok 即可。
 */

import { MSG, type RpcError, type RpcResult } from './protocol.js';

const DEFAULT_TIMEOUT_MS = 20000;

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<RpcResult<T>> => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    return new Promise((resolve) => {
        timer = setTimeout(() => {
            resolve({ ok: false, error: { code: 'TIMEOUT', message: 'request timeout' } });
        }, ms);
        promise
            .then((value) => resolve({ ok: true, data: value }))
            .catch((error) => resolve({ ok: false, error: normalizeRuntimeError(error) }))
            .finally(() => {
                if (timer) clearTimeout(timer);
            });
    });
};

const normalizeRuntimeError = (error: unknown): RpcError => {
    const message = error instanceof Error ? error.message : String(error || '');
    if (message.includes('message port closed') || message.includes('Message port closed')) {
        return { code: 'PORT_CLOSED', message };
    }
    if (message.includes('Receiving end does not exist')) {
        return { code: 'NO_RECEIVER', message };
    }
    return { code: 'RUNTIME_ERROR', message };
};

const runtimeRequest = async <T>(req: any, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RpcResult<T>> => {
    const promise = new Promise<T>((resolve, reject) => {
        chrome.runtime.sendMessage(req, (response: any) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response as T);
        });
    });
    return withTimeout(promise, timeoutMs);
};

const tabRequest = async <T>(
    tabId: number,
    req: any,
    timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RpcResult<T>> => {
    const promise = new Promise<T>((resolve, reject) => {
        chrome.tabs.sendMessage(tabId, req, (response: any) => {
            if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
                return;
            }
            resolve(response as T);
        });
    });
    return withTimeout(promise, timeoutMs);
};

export const send = {
    /**
     * 向 SW 发送 hello（content -> SW）。
     */
    hello: (payload: { tabToken: string; url: string }) =>
        runtimeRequest<{ ok: boolean }>(
            { type: MSG.HELLO, ...payload },
            5000,
        ),

    /**
     * 发送 Action（content/panel -> SW）。
     */
    action: <T = any>(action: any) => runtimeRequest<T>({ type: MSG.ACTION, action }),

    /**
     * 向指定 tab 发送消息（SW -> content）。
     */
    toTab: <T = any>(tabId: number, type: string, payload?: any, opts?: { timeoutMs?: number }) =>
        tabRequest<T>(tabId, { type, ...payload }, opts?.timeoutMs),

};
