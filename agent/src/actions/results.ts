import { failedAction, type Action } from './action_protocol';

export const ERROR_CODES = {
    ERR_TIMEOUT: 'ERR_TIMEOUT',
    ERR_NOT_FOUND: 'ERR_NOT_FOUND',
    ERR_STALE: 'ERR_STALE',
    ERR_UNSUPPORTED: 'ERR_UNSUPPORTED',
    ERR_ASSERTION_FAILED: 'ERR_ASSERTION_FAILED',
    ERR_DIALOG_BLOCKED: 'ERR_DIALOG_BLOCKED',
    ERR_POPUP_BLOCKED: 'ERR_POPUP_BLOCKED',
    ERR_INTERNAL: 'ERR_INTERNAL',
    ERR_BAD_ARGS: 'ERR_BAD_ARGS',
    ERR_WORKFLOW_BAD_ARGS: 'ERR_WORKFLOW_BAD_ARGS',
    ERR_WORKSPACE_SNAPSHOT_NOT_FOUND: 'ERR_WORKSPACE_SNAPSHOT_NOT_FOUND',
    ERR_WORKSPACE_RESTORE_FAILED: 'ERR_WORKSPACE_RESTORE_FAILED',
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

export const toFailedAction = (request: Action, error: unknown): Action => {
    if (error instanceof ActionError) {
        return failedAction(request, error.code, error.message, error.details);
    }
    if (error instanceof Error) {
        if (error.name === 'TimeoutError') {
            return failedAction(request, ERROR_CODES.ERR_TIMEOUT, error.message);
        }
        return failedAction(request, ERROR_CODES.ERR_BAD_ARGS, error.message);
    }
    return failedAction(request, ERROR_CODES.ERR_BAD_ARGS, String(error));
};

export const unsupportedActionFailure = (request: Action): Action =>
    failedAction(request, ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${request.type}`);

export type ErrorResult = {
    ok: false;
    requestId?: string;
    tabName: string;
    error: {
        code: ErrorCode;
        message: string;
        details?: unknown;
    };
};

export type SuccessResult<T = unknown> = {
    ok: true;
    requestId?: string;
    tabName: string;
    data: T;
};

export type Result<T = unknown> = SuccessResult<T> | ErrorResult;

export const okResult = <T>(tabName: string, data: T, requestId?: string): SuccessResult<T> => ({
    ok: true,
    tabName,
    requestId,
    data,
});

export const errorResult = (
    tabName: string,
    code: ErrorCode,
    message: string,
    requestId?: string,
    details?: unknown,
): ErrorResult => ({
    ok: false,
    tabName,
    requestId,
    error: { code, message, details },
});
