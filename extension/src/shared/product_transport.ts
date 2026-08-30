/**
 * Product backend transport — the typed product command surface shared by the
 * product UI (content side) and the SW. The ordinary product path runs over
 * the trusted workspace WebSocket as ONE `agent.product` Action; the SW never
 * reads service base URLs from chrome.storage and no token crosses into the
 * page. `createProductHttpClient` remains only as a direct/external utility
 * for tests and tooling that speak the `/agent/product` HTTP surface.
 *
 * Route authority: agent/src/agent/service/server.ts (`/agent/product`) and
 * agent/src/agent/service/control.ts (`agent.product` Action dispatch).
 */

import { MSG } from './protocol.js';

export type BackendTaskView = Record<string, unknown>;
export type BackendWorkspaceView = Record<string, unknown>;
export type BackendEvent = Record<string, unknown>;
export type BackendTaskList = Readonly<{ active: readonly BackendTaskView[]; history: readonly BackendTaskView[] }>;
export type BackendEventsResponse = Readonly<{ events: readonly BackendEvent[]; nextSeq: number; gap: boolean }>;
export type BackendLibrarySummary = Record<string, unknown>;

export type GuidanceMode = 'manual' | 'teach' | 'annotate';

export type TeachKind = 'procedure' | 'recovery' | 'demonstration';

export type AuthoringActivity = 'teach' | 'annotate';

export type AuthoringOutcome = 'saved' | 'discarded';

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
    beginAuthoring(input: {activity: 'teach'; teachKind: TeachKind} | {activity: 'annotate'}): Promise<BackendWorkspaceView>;
    endAuthoring(outcome: AuthoringOutcome): Promise<BackendWorkspaceView>;
    librarySummary(): Promise<BackendLibrarySummary>;
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
        beginAuthoring: (input) => request('POST', '/agent/product/authoring/begin', input),
        endAuthoring: (outcome) => request('POST', '/agent/product/authoring/end', { outcome }),
        librarySummary: () => request('GET', '/agent/product/library'),
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
    | { verb: 'returnControl'; taskId: string; interactionToken: string; mode: GuidanceMode; savedReference?: string }
    | { verb: 'beginAuthoring'; activity: AuthoringActivity; teachKind?: TeachKind }
    | { verb: 'endAuthoring'; outcome: AuthoringOutcome }
    | { verb: 'librarySummary' };

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
        case 'beginAuthoring':
            if (body.activity === 'annotate') {
                return await client.beginAuthoring({ activity: 'annotate' });
            }
            if (body.activity === 'teach') {
                const teachKind = body.teachKind === 'recovery' || body.teachKind === 'demonstration'
                    ? body.teachKind
                    : 'procedure';
                return await client.beginAuthoring({ activity: 'teach', teachKind });
            }
            throw new ProductTransportError('bad_args', `unsupported authoring activity: ${String(body.activity)}`);
        case 'endAuthoring':
            return await client.endAuthoring(body.outcome === 'saved' ? 'saved' : 'discarded');
        case 'librarySummary':
            return await client.librarySummary();
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
        beginAuthoring: (input) =>
            call({
                verb: 'beginAuthoring',
                activity: input.activity,
                ...(input.activity === 'teach' ? { teachKind: input.teachKind } : {}),
            }) as Promise<BackendWorkspaceView>,
        endAuthoring: (outcome) => call({ verb: 'endAuthoring', outcome }) as Promise<BackendWorkspaceView>,
        librarySummary: () => call({ verb: 'librarySummary' }) as Promise<BackendLibrarySummary>,
    };
};

/** Action-plane classification of an `agent.product` reply from the SW's
 *  trusted WebSocket; the UI keeps consuming only ProductMessageReply. */
export type ProductActionReplyLike = Readonly<{
    v: number;
    type: string;
    payload?: unknown;
    replyTo?: string;
}>;

const ACTION_ERROR_CODE_TO_TRANSPORT: Record<string, ProductTransportErrorCode> = {
    ERR_STALE: 'stale',
    ERR_INTERACTION_CONCURRENCY: 'stale',
    ERR_NOT_FOUND: 'not_found',
    ERR_WORKSPACE_SNAPSHOT_NOT_FOUND: 'not_found',
    ERR_CONFLICT: 'conflict',
    ERR_ACTIVITY_CONFLICT: 'conflict',
    ERR_BAD_STATE: 'conflict',
    ERR_BAD_ARGS: 'bad_args',
    ERR_UNSUPPORTED: 'bad_args',
    ERR_TIMEOUT: 'unreachable',
    ERR_CLOSED: 'unreachable',
    ERR_CONNECT: 'unreachable',
    ERR_RECONNECT: 'unreachable',
};

export const productReplyFromAction = (reply: ProductActionReplyLike): ProductMessageReply => {
    if (reply.type.endsWith('.result')) {
        return { ok: true, data: reply.payload };
    }
    const record = isRecord(reply.payload) ? reply.payload : {};
    const code = typeof record.code === 'string' ? record.code : 'ERR_INTERNAL';
    const message = typeof record.message === 'string' && record.message.trim().length > 0
        ? record.message
        : `product action failed: ${code}`;
    const details = isRecord(record.details) ? record.details : undefined;
    const detailCode = typeof details?.productCode === 'string' ? details.productCode : code;
    return {
        ok: false,
        error: {
            code: ACTION_ERROR_CODE_TO_TRANSPORT[code] ?? 'http',
            message,
            detailCode,
        },
    };
};