import { failedAction, type Action } from './action_protocol.js';

export const ERROR_CODES = {
    ERR_TIMEOUT: 'ERR_TIMEOUT',
    ERR_NOT_FOUND: 'ERR_NOT_FOUND',
    ERR_STALE: 'ERR_STALE',
    ERR_UNSUPPORTED: 'ERR_UNSUPPORTED',
    ERR_ASSERTION_FAILED: 'ERR_ASSERTION_FAILED',
    ERR_DIALOG_BLOCKED: 'ERR_DIALOG_BLOCKED',
    ERR_POPUP_BLOCKED: 'ERR_POPUP_BLOCKED',
    ERR_BAD_ARGS: 'ERR_BAD_ARGS',
    ERR_WORKFLOW_BAD_ARGS: 'ERR_WORKFLOW_BAD_ARGS',
    ERR_WORKSPACE_SNAPSHOT_NOT_FOUND: 'ERR_WORKSPACE_SNAPSHOT_NOT_FOUND',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class ActionError extends Error {
    code: ErrorCode;
    details?: unknown;

    constructor(code: ErrorCode, message: string, details?: unknown) {
        super(message);
        this.code = code;
        this.details = details;
    }
}

export const mkActionDispatchFailed = (replyTo: string | undefined, code: string, message: string): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: 'action.dispatch.failed',
    replyTo,
    payload: { code, message },
    at: Date.now(),
});

export const mkRequestFailedReply = (requestType: string, requestId: string | undefined, code: string, message: string): Action =>
    failedAction({ id: requestId || crypto.randomUUID(), type: requestType }, code, message);

export type ErrorResult = {
    ok: false;
    error: {
        code: ErrorCode;
        message: string;
        details?: unknown;
    };
};

export type SuccessResult<T = unknown> = {
    ok: true;
    data: T;
};

export type Result<T = unknown> = SuccessResult<T> | ErrorResult;

export const okResult = <T>(data: T): SuccessResult<T> => ({ ok: true, data });
export const errorResult = (code: ErrorCode, message: string, details?: unknown): ErrorResult => ({
    ok: false,
    error: { code, message, details },
});
