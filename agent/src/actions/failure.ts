import { failedAction, type Action } from './action_protocol';
import { ERROR_CODES, type ErrorCode } from './error_codes';

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
