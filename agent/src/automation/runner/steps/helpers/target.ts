import type { StepResult } from '../types';
import type { ToolError } from '../../trace/types';

export const mapTraceError = (error: ToolError | undefined): StepResult['error'] => {
    if (!error) {
        return { code: 'ERR_INTERNAL', message: 'trace error' };
    }
    if (
        error.code === 'ERR_NOT_FOUND' ||
        error.code === 'ERR_AMBIGUOUS' ||
        error.code === 'ERR_TIMEOUT' ||
        error.code === 'ERR_BAD_ARGS'
    ) {
        return { code: error.code, message: error.message, details: error.details };
    }
    return { code: 'ERR_INTERNAL', message: error.message || 'internal error', details: error.details };
};
