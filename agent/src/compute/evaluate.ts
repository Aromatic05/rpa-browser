import {isDeepStrictEqual} from 'node:util';
import type {ComputeExpr, ComputeValue} from './types';
import {COMPUTE_OP_ARITY} from './ops';

export type ComputeEvalScope = {
    steps?: Readonly<Record<string, unknown>>;
    input?: Readonly<Record<string, unknown>>;
    local?: Readonly<Record<string, unknown>>;
    vars?: Readonly<Record<string, unknown>>;
    output?: Readonly<Record<string, unknown>>;
    failure?: Readonly<Record<string, unknown>>;
};

export const evaluateComputeExpression = (
    expr: ComputeExpr,
    scope: ComputeEvalScope = {},
): unknown => {
    const args = expr.args.map((arg) => evaluateValue(arg, scope));
    assertArity(expr.op, args);
    switch (expr.op) {
        case 'len':
            return opLen(args[0]);
        case 'exists':
            return opExists(args[0]);
        case 'first':
            return opFirst(args[0]);
        case 'get':
            return opGet(args[0], args[1]);
        case 'eq':
            return isDeepStrictEqual(args[0], args[1]);
        case 'not':
            return !toBoolean(args[0]);
        case 'and':
            return toBoolean(args[0]) && toBoolean(args[1]);
        case 'or':
            return toBoolean(args[0]) || toBoolean(args[1]);
        default:
            throw new Error(`unsupported compute op: ${(expr as {op?: string}).op || 'unknown'}`);
    }
};

const evaluateValue = (value: ComputeValue, scope: ComputeEvalScope): unknown => {
    if (isExpression(value)) {return evaluateComputeExpression(value, scope);}
    if ('literal' in value) {return value.literal;}
    if ('ref' in value) {return resolvePath(scope, value.ref.path);}
    throw new Error('invalid compute value');
};

const isExpression = (value: ComputeValue): value is ComputeExpr =>
    typeof value === 'object' && 'op' in value && 'args' in value;

const resolvePath = (scope: ComputeEvalScope, path: string): unknown => {
    if (!path || typeof path !== 'string') {throw new Error('compute ref.path is required');}
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

const opLen = (value: unknown): number => {
    if (Array.isArray(value) || typeof value === 'string') {return value.length;}
    if (value && typeof value === 'object') {return Object.keys(value).length;}
    return 0;
};

const opExists = (value: unknown): boolean => {
    if (Array.isArray(value) || typeof value === 'string') {return value.length > 0;}
    if (value && typeof value === 'object') {return Object.keys(value).length > 0;}
    return value !== null && value !== undefined;
};

const opFirst = (value: unknown): unknown => Array.isArray(value) ? value[0] : undefined;

const opGet = (value: unknown, indexValue: unknown): unknown => {
    if (!Number.isInteger(indexValue)) {throw new Error('get index must be an integer');}
    const index = indexValue as number;
    if (Array.isArray(value)) {return value[index];}
    if (typeof value === 'string') {return value[index];}
    if (value && typeof value === 'object') {return (value as Record<string, unknown>)[String(index)];}
    return undefined;
};

const toBoolean = (value: unknown): boolean => typeof value === 'boolean' ? value : Boolean(value);

const assertArity = (op: ComputeExpr['op'], args: unknown[]): void => {
    const expected = COMPUTE_OP_ARITY[op];
    if (args.length !== expected) {throw new Error(`${op} expects ${expected} args`);}
};
