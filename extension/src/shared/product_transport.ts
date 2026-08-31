/**
 * Product backend transport — the only place in the product pipeline that knows
 * the raw `/agent/product` HTTP routes and their error mapping. The controller
 * and every UI component consume only the typed `ProductBackendClient`; the SW
 * proxy executes the same client over `fetch`, and the content side proxies it
 * over a runtime message so neither layer hard-codes the HTTP surface.
 *
 * Route authority: agent/src/agent/service/server.ts (`/agent/product`).
 */

import { MSG } from './protocol.js';

export const PRODUCT_BASE_URL_KEY = 'rpaProductBaseUrl';

export type BackendTaskView = Record<string, unknown>;
export type BackendWorkspaceView = Record<string, unknown>;
export type BackendEvent = Record<string, unknown>;
export type BackendTaskList = Readonly<{ active: readonly BackendTaskView[]; history: readonly BackendTaskView[] }>;
export type BackendEventsResponse = Readonly<{ events: readonly BackendEvent[]; nextSeq: number; gap: boolean }>;

export type GuidanceMode = 'manual' | 'teach' | 'annotate';

export type ProductTransportErrorCode =
    | 'unreachable'
    | 'auth'
    | 'not_found'
    | 'stale'
    | 'conflict'
    | 'bad_args'
    | 'http';

export class ProductTransportError extends Error {
    readonly code: ProductTransportErrorCode;
    readonly status?: number;
    readonly detailCode?: string;

    constructor(
        code: ProductTransportErrorCode,
        message: string,
        details?: { status?: number; detailCode?: string },
    ) {
        super(message);
        this.name = 'ProductTransportError';
        this.code = code;
        this.status = details?.status;
        this.detailCode = details?.detailCode;
    }
}

export const isProductTransportError = (error: unknown): error is ProductTransportError =>
    error instanceof ProductTransportError;

/** Typed product command surface resolved for one agent product request. */
export interface ProductBackendClient {
    workspaceView(): Promise<BackendWorkspaceView>;
    listTasks(): Promise<BackendTaskList>;
    startTask(prompt: string): Promise<BackendTaskView>;
    taskView(taskId: string): Promise<BackendTaskView>;
    events(taskId: string, afterSeq: number): Promise<BackendEventsResponse>;
    stopTask(taskId: string): Promise<BackendTaskView>;
    approve(taskId: string, interactionToken: string): Promise<BackendTaskView>;
    deny(taskId: string, interactionToken: string, reason: string, requestedAlternative?: string): Promise<BackendTaskView>;
    answer(taskId: string, interactionToken: string, value: unknown): Promise<BackendTaskView>;
    chooseRecovery(taskId: string, interactionToken: string, optionId: string): Promise<BackendTaskView>;
    beginGuidance(taskId: string, interactionToken: string, mode: GuidanceMode): Promise<BackendTaskView>;
    returnControl(taskId: string, interactionToken: string, mode: GuidanceMode, savedReference?: string): Promise<BackendTaskView>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const taskBase = (taskId: string): string => `/agent/product/tasks/${encodeURIComponent(taskId)}`;

const toError = (res: {status: number}, body: unknown): ProductTransportError => {
    const record = isRecord(body) ? body : {};
    const detailCode = typeof record.code === 'string' ? record.code : undefined;
    const message =
        (typeof record.error === 'string' && record.error.trim() ? record.error.trim() : '')
        || (typeof record.message === 'string' && record.message.trim() ? record.message.trim() : '')
        || `HTTP ${String(res.status)}`;
    const status = res.status;
    if (status === 401 || status === 403) {
        return new ProductTransportError('auth', message, { status, detailCode });
    }
    if (status === 404) {
        return new ProductTransportError('not_found', message, { status, detailCode });
    }
    if (status === 409 && (detailCode === 'ERR_STALE' || detailCode === 'ERR_INTERACTION_CONCURRENCY')) {
        return new ProductTransportError('stale', message, { status, detailCode });
    }
    if (status === 409) {
        return new ProductTransportError('conflict', message, { status, detailCode });
    }
    if (status === 400) {
        return new ProductTransportError('bad_args', message, { status, detailCode });
    }
    return new ProductTransportError('http', message, { status, detailCode });
};

export type ProductHttpClientOptions = {
    baseUrl: string;
    fetch?: typeof fetch;
};

export const createProductHttpClient = (options: ProductHttpClientOptions): ProductBackendClient => {
    const fetcher = options.fetch ?? fetch;
    const base = options.baseUrl.trim().replace(/\/+$/u, '');
    if (!/^https?:\/\//u.test(base)) {
        throw new ProductTransportError('unreachable', 'product service base URL must be an absolute http(s) URL');
    }

    const request = async <T>(method: 'GET' | 'POST', urlPath: string, body?: unknown): Promise<T> => {
        let res: Response;
        try {
            res = await fetcher(`${base}${urlPath}`, {
                method,
                headers: { 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
        } catch (error) {
            throw new ProductTransportError(
                'unreachable',
                error instanceof Error ? error.message : 'network request failed',
            );
        }
        if (!res.ok) {
            let raw: unknown;
            try {
                raw = await res.json();
            } catch {
                raw = undefined;
            }
            throw toError(res, raw);
        }
        try {
            return (await res.json()) as T;
        } catch {
            throw new ProductTransportError('unreachable', 'empty or malformed product response');
        }
    };

    return {
        workspaceView: () => request('GET', '/agent/product'),
        listTasks: () => request('GET', '/agent/product/tasks'),
        startTask: (prompt) => request('POST', '/agent/product/tasks', { prompt }),
        taskView: (taskId) => request('GET', taskBase(taskId)),
        events: (taskId, afterSeq) => request('GET', `${taskBase(taskId)}/events?afterSeq=${String(afterSeq)}`),
        stopTask: (taskId) => request('POST', `${taskBase(taskId)}/stop`, {}),
        approve: (taskId, interactionToken) =>
            request('POST', `${taskBase(taskId)}/approve`, { interactionToken }),
        deny: (taskId, interactionToken, reason, requestedAlternative) =>
            request('POST', `${taskBase(taskId)}/deny`, {
                interactionToken,
                reason,
                ...(requestedAlternative === undefined ? {} : { requestedAlternative }),
            }),
        answer: (taskId, interactionToken, value) =>
            request('POST', `${taskBase(taskId)}/answer`, { interactionToken, value }),
        chooseRecovery: (taskId, interactionToken, optionId) =>
            request('POST', `${taskBase(taskId)}/recovery`, { interactionToken, optionId }),
        beginGuidance: (taskId, interactionToken, mode) =>
            request('POST', `${taskBase(taskId)}/takeover`, { interactionToken, mode }),
        returnControl: (taskId, interactionToken, mode, savedReference) =>
            request('POST', `${taskBase(taskId)}/return-control`, {
                interactionToken,
                mode,
                ...(savedReference === undefined ? {} : { savedReference }),
            }),
    };
};

export type ProductRequest =
    | { verb: 'workspaceView' }
    | { verb: 'listTasks' }
    | { verb: 'startTask'; prompt: string }
    | { verb: 'taskView'; taskId: string }
    | { verb: 'events'; taskId: string; afterSeq: number }
    | { verb: 'stopTask'; taskId: string }
    | { verb: 'approve'; taskId: string; interactionToken: string }
    | { verb: 'deny'; taskId: string; interactionToken: string; reason: string; requestedAlternative?: string }
    | { verb: 'answer'; taskId: string; interactionToken: string; value: unknown }
    | { verb: 'recovery'; taskId: string; interactionToken: string; optionId: string }
    | { verb: 'takeover'; taskId: string; interactionToken: string; mode: GuidanceMode }
    | { verb: 'returnControl'; taskId: string; interactionToken: string; mode: GuidanceMode; savedReference?: string };

/** Pure dispatcher: maps a typed product request onto the backend client. */
export const dispatchProductRequest = async (client: ProductBackendClient, request: ProductRequest): Promise<unknown> => {
    const body = request as unknown as Record<string, unknown>;
    switch (body.verb) {
        case 'workspaceView':
            return await client.workspaceView();
        case 'listTasks':
            return await client.listTasks();
        case 'startTask':
            return await client.startTask(typeof body.prompt === 'string' ? body.prompt : '');
        case 'taskView':
            return await client.taskView(typeof body.taskId === 'string' ? body.taskId : '');
        case 'events':
            return await client.events(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.afterSeq === 'number' ? body.afterSeq : 0,
            );
        case 'stopTask':
            return await client.stopTask(typeof body.taskId === 'string' ? body.taskId : '');
        case 'approve':
            return await client.approve(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
            );
        case 'deny':
            return await client.deny(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
                typeof body.reason === 'string' ? body.reason : '',
                typeof body.requestedAlternative === 'string' ? body.requestedAlternative : undefined,
            );
        case 'answer':
            return await client.answer(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
                body.value,
            );
        case 'recovery':
            return await client.chooseRecovery(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
                typeof body.optionId === 'string' ? body.optionId : '',
            );
        case 'takeover':
            return await client.beginGuidance(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
                body.mode === 'manual' || body.mode === 'teach' || body.mode === 'annotate' ? body.mode : 'manual',
            );
        case 'returnControl':
            return await client.returnControl(
                typeof body.taskId === 'string' ? body.taskId : '',
                typeof body.interactionToken === 'string' ? body.interactionToken : '',
                body.mode === 'manual' || body.mode === 'teach' || body.mode === 'annotate' ? body.mode : 'manual',
                typeof body.savedReference === 'string' ? body.savedReference : undefined,
            );
        default:
            throw new ProductTransportError('bad_args', `unsupported product request verb: ${String(body.verb)}`);
    }
};

export type ProductMessageError = {
    code: ProductTransportErrorCode;
    message: string;
    status?: number;
    detailCode?: string;
};

export type ProductMessageReply =
    | { ok: true; data?: unknown }
    | { ok: false; error: ProductMessageError };

export const productErrorMessageShape = (error: unknown): ProductMessageError => {
    if (error instanceof ProductTransportError) {
        return { code: error.code, message: error.message, status: error.status, detailCode: error.detailCode };
    }
    return {
        code: 'unreachable',
        message: error instanceof Error ? error.message : String(error),
    };
};

/** Content-side client: proxies each product call to the SW which holds the
 *  CORS-free HTTP fetch against the configured product service. */
export const createProductMessageClient = (): ProductBackendClient => {
    const call = async (request: ProductRequest): Promise<unknown> => {
        const reply: ProductMessageReply | undefined = await chrome.runtime.sendMessage({
            type: MSG.PRODUCT,
            request,
        });
        if (reply?.ok) {
            return reply.data;
        }
        const failed = reply?.error ?? { code: 'unreachable' as const, message: 'product transport failed' };
        throw new ProductTransportError(failed.code, failed.message, {
            status: failed.status,
            detailCode: failed.detailCode,
        });
    };
    return {
        workspaceView: () => call({ verb: 'workspaceView' }) as Promise<BackendWorkspaceView>,
        listTasks: () => call({ verb: 'listTasks' }) as Promise<BackendTaskList>,
        startTask: (prompt) => call({ verb: 'startTask', prompt }) as Promise<BackendTaskView>,
        taskView: (taskId) => call({ verb: 'taskView', taskId }) as Promise<BackendTaskView>,
        events: (taskId, afterSeq) => call({ verb: 'events', taskId, afterSeq }) as Promise<BackendEventsResponse>,
        stopTask: (taskId) => call({ verb: 'stopTask', taskId }) as Promise<BackendTaskView>,
        approve: (taskId, interactionToken) =>
            call({ verb: 'approve', taskId, interactionToken }) as Promise<BackendTaskView>,
        deny: (taskId, interactionToken, reason, requestedAlternative) =>
            call({ verb: 'deny', taskId, interactionToken, reason, requestedAlternative }) as Promise<BackendTaskView>,
        answer: (taskId, interactionToken, value) =>
            call({ verb: 'answer', taskId, interactionToken, value }) as Promise<BackendTaskView>,
        chooseRecovery: (taskId, interactionToken, optionId) =>
            call({ verb: 'recovery', taskId, interactionToken, optionId }) as Promise<BackendTaskView>,
        beginGuidance: (taskId, interactionToken, mode) =>
            call({ verb: 'takeover', taskId, interactionToken, mode }) as Promise<BackendTaskView>,
        returnControl: (taskId, interactionToken, mode, savedReference) =>
            call({ verb: 'returnControl', taskId, interactionToken, mode, savedReference }) as Promise<BackendTaskView>,
    };
};

/** SW-side read of the configured product service base URL (extension-owned). */
export const readProductBaseUrl = async (): Promise<string> => {
    const stored = await chrome.storage.local.get(PRODUCT_BASE_URL_KEY);
    const value: unknown = stored[PRODUCT_BASE_URL_KEY];
    return typeof value === 'string' ? value.trim() : '';
};