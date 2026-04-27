import type { Step, StepResult, StepUnion } from './steps/types';

type CachedStepResult = {
    ok: boolean;
    data?: unknown;
    error?: unknown;
};

export type StepResultRefContext = {
    getResult: (stepId: string) => CachedStepResult | undefined;
};

const FULL_REF_PATTERN = /^\{\{\s*([A-Za-z0-9_-]+(?:\.(?:[A-Za-z0-9_$-]+|\d+))*)\s*\}\}$/;
const REF_TOKEN_PATTERN = /\{\{|\}\}/;

export const resolveStepArgsRefs = <T extends StepUnion>(
    step: T,
    context: StepResultRefContext,
): { ok: true; step: T } | { ok: false; error: StepResult['error'] } => {
    const resolved = resolveValue(step.args, context);
    if (!resolved.ok) {
        return {
            ok: false,
            error: resolved.error,
        };
    }

    return {
        ok: true,
        step: {
            ...step,
            args: resolved.value as Step<T['name']>['args'],
        },
    };
};

const resolveValue = (
    value: unknown,
    context: StepResultRefContext,
): { ok: true; value: unknown } | { ok: false; error: StepResult['error'] } => {
    if (typeof value === 'string') {
        return resolveStringRef(value, context);
    }

    if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (const item of value) {
            const resolved = resolveValue(item, context);
            if (!resolved.ok) {return resolved;}
            out.push(resolved.value);
        }
        return { ok: true, value: out };
    }

    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            const resolved = resolveValue(child, context);
            if (!resolved.ok) {return resolved;}
            out[key] = resolved.value;
        }
        return { ok: true, value: out };
    }

    return { ok: true, value };
};

const resolveStringRef = (
    value: string,
    context: StepResultRefContext,
): { ok: true; value: unknown } | { ok: false; error: StepResult['error'] } => {
    const matched = FULL_REF_PATTERN.exec(value);
    if (!matched) {
        if (REF_TOKEN_PATTERN.test(value)) {
            return badArgs(`unsupported ref expression: ${value}`);
        }
        return {
            ok: true,
            value,
        };
    }

    const expression = matched[1];
    const [stepId, ...path] = expression.split('.');
    const stepResult = context.getResult(stepId);
    if (!stepResult) {
        return badArgs(`referenced step not found: ${stepId}`);
    }
    if (!stepResult.ok) {
        return {
            ok: false,
            error: {
                code: 'ERR_DEPENDENCY_FAILED',
                message: `referenced step failed: ${stepId}`,
                details: {
                    stepId,
                    error: stepResult.error,
                },
            },
        };
    }

    let cursor: unknown = stepResult;
    for (const segment of path) {
        if (Array.isArray(cursor)) {
            const index = Number(segment);
            if (!Number.isInteger(index) || index < 0 || index >= cursor.length) {
                return badArgs(`missing ref path: ${expression}`);
            }
            cursor = cursor[index];
            continue;
        }

        if (!cursor || typeof cursor !== 'object' || !Object.prototype.hasOwnProperty.call(cursor, segment)) {
            return badArgs(`missing ref path: ${expression}`);
        }

        cursor = (cursor as Record<string, unknown>)[segment];
    }

    return {
        ok: true,
        value: cursor,
    };
};

const badArgs = (message: string): { ok: false; error: StepResult['error'] } => ({
    ok: false,
    error: {
        code: 'ERR_BAD_ARGS',
        message,
    },
});
