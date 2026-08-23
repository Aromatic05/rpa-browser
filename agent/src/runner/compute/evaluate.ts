import {isDeepStrictEqual} from 'node:util';
import type {ComputeExpr, ComputeValue} from '../steps/types';

export type ComputeEvalScope = {
    steps?: Record<string, unknown>;
    input?: Record<string, unknown>;
    local?: Record<string, unknown>;
    output?: Record<string, unknown>;
};

export const evaluateComputeExpression = (
    expr: ComputeExpr,
    scope: ComputeEvalScope = {},
): unknown => {
    const args = expr.args.map((arg) => evaluateValue(arg, scope));
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

const assertArity = (op: string, args: unknown[], expected: number): void => {
    if (args.length !== expected) {throw new Error(`${op} expects ${expected} args`);}
};
