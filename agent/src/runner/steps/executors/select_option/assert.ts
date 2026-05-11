import type { StepResult } from '../../types';

export const ERR_BAD_ARGS = 'ERR_BAD_ARGS' as const;
export const ERR_NOT_FOUND = 'ERR_NOT_FOUND' as const;
export const ERR_AMBIGUOUS = 'ERR_AMBIGUOUS' as const;
export const ERR_ASSERTION_FAILED = 'ERR_ASSERTION_FAILED' as const;

export const errorResult = (
    stepId: string,
    code: string,
    message: string,
    details?: unknown,
): StepResult => ({
    stepId,
    ok: false,
    error: { code, message, details },
});

export const badArgs = (stepId: string, message: string, details?: unknown): StepResult =>
    errorResult(stepId, ERR_BAD_ARGS, message, details);

export const notFound = (stepId: string, message: string, details?: unknown): StepResult =>
    errorResult(stepId, ERR_NOT_FOUND, message, details);

export const ambiguous = (stepId: string, message: string, details?: unknown): StepResult =>
    errorResult(stepId, ERR_AMBIGUOUS, message, details);

export const assertionFailed = (stepId: string, message: string, details?: unknown): StepResult =>
    errorResult(stepId, ERR_ASSERTION_FAILED, message, details);

export const validateValues = (stepId: string, values: unknown): string[] | StepResult => {
    if (!Array.isArray(values) || values.length === 0) {
        return badArgs(stepId, 'values must be a non-empty array', { values });
    }
    const normalized = values
        .map((v) => (typeof v === 'string' ? v : String(v)))
        .filter((v) => v.trim().length > 0);
    if (normalized.length === 0) {
        return badArgs(stepId, 'values must contain non-empty strings', { values });
    }
    return normalized;
};

export const isStepResult = <T>(value: T | StepResult): value is StepResult => {
    return typeof value === 'object' && value !== null && 'error' in value;
};
