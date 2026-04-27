import { isDeepStrictEqual } from 'node:util';
import type { ComputeExpr, ComputeValue, Step, StepResult } from '../types';
import type { RunLocalStepResults, RunStepsDeps } from '../../run_steps';

type EvalScope = {
    steps?: RunLocalStepResults;
    input?: Record<string, unknown>;
    local?: Record<string, unknown>;
    output?: Record<string, unknown>;
};

export const executeBrowserCompute = async (
    step: Step<'browser.compute'>,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const binding = await deps.runtime.ensureActivePage(workspaceId);
    const cache = binding.traceCtx.cache as { computeScope?: unknown; runnerStepResults?: unknown };
    const scope: EvalScope = {
        steps: asRecord<RunLocalStepResults>(cache.runnerStepResults),
        ...(asRecord<EvalScope>(cache.computeScope) || {}),
    };

    try {
        const value = evalExpr(step.args.expr, scope);
        return {
            stepId: step.id,
            ok: true,
            data: {
                value,
            },
        };
    } catch (error) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: error instanceof Error ? error.message : 'invalid compute expression',
            },
        };
    }
};

const evalExpr = (expr: ComputeExpr, scope: EvalScope): unknown => {
    const args = expr.args.map((arg) => evalValue(arg, scope));
    switch (expr.op) {
        case 'len':
            assertArity('len', args, 1);
            return opLen(args[0]);
        case 'exists':
            assertArity('exists', args, 1);
            return opExists(args[0]);
        case 'first':
            assertArity('first', args, 1);
            return opFirst(args[0]);
        case 'get':
            assertArity('get', args, 2);
            return opGet(args[0], args[1]);
        case 'eq':
            assertArity('eq', args, 2);
            return isDeepStrictEqual(args[0], args[1]);
        case 'not':
            assertArity('not', args, 1);
            return !toBoolean(args[0]);
        case 'and':
            assertArity('and', args, 2);
            return toBoolean(args[0]) && toBoolean(args[1]);
        case 'or':
            assertArity('or', args, 2);
            return toBoolean(args[0]) || toBoolean(args[1]);
        default:
            throw new Error(`unsupported compute op: ${(expr as { op?: string }).op || 'unknown'}`);
    }
};

const evalValue = (value: ComputeValue, scope: EvalScope): unknown => {
    if (isExpr(value)) {
        return evalExpr(value, scope);
    }
    if ('literal' in value) {
        return value.literal;
    }
    if ('ref' in value) {
        return resolvePath(scope, value.ref.path);
    }
    throw new Error('invalid compute value');
};

const isExpr = (value: ComputeValue): value is ComputeExpr => {
    if (typeof value !== 'object') {return false;}
    return 'op' in value && 'args' in value;
};

const resolvePath = (scope: EvalScope, path: string): unknown => {
    if (!path || typeof path !== 'string') {
        throw new Error('compute ref.path is required');
    }

    const keys = path.split('.').filter(Boolean);
    let cursor: unknown = scope;
    for (const key of keys) {
        if (!cursor || typeof cursor !== 'object' || !(key in (cursor as Record<string, unknown>))) {
            throw new Error(`missing compute ref: ${path}`);
        }
        cursor = (cursor as Record<string, unknown>)[key];
    }
    return cursor;
};

const opLen = (value: unknown) => {
    if (Array.isArray(value) || typeof value === 'string') {
        return value.length;
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).length;
    }
    return 0;
};

const opExists = (value: unknown) => {
    if (Array.isArray(value) || typeof value === 'string') {
        return value.length > 0;
    }
    if (value && typeof value === 'object') {
        return Object.keys(value).length > 0;
    }
    return value !== null && value !== undefined;
};

const opFirst = (value: unknown) => {
    if (!Array.isArray(value)) {return undefined;}
    return value[0] as unknown;
};

const opGet = (value: unknown, indexValue: unknown) => {
    if (!Number.isInteger(indexValue)) {
        throw new Error('get index must be an integer');
    }
    const index = indexValue as number;
    if (Array.isArray(value)) {
        return value[index] as unknown;
    }
    if (typeof value === 'string') {
        return value[index];
    }
    if (value && typeof value === 'object') {
        return (value as Record<string, unknown>)[String(index)];
    }
    return undefined;
};

const toBoolean = (value: unknown) => {
    if (typeof value === 'boolean') {return value;}
    return Boolean(value);
};

const assertArity = (op: string, args: unknown[], expected: number) => {
    if (args.length !== expected) {
        throw new Error(`${op} expects ${expected} args`);
    }
};

const asRecord = <T extends Record<string, unknown>>(value: unknown): T | undefined => {
    if (!value || typeof value !== 'object') {return undefined;}
    return value as T;
};
