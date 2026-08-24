import type {ComputeOp} from './types';

export const COMPUTE_OP_ARITY: Readonly<Record<ComputeOp, number>> = Object.freeze({
    len: 1,
    exists: 1,
    first: 1,
    get: 2,
    eq: 2,
    not: 1,
    and: 2,
    or: 2,
});

export const isComputeOp = (value: string): value is ComputeOp =>
    Object.hasOwn(COMPUTE_OP_ARITY, value);
