export type ComputeOp = 'len' | 'exists' | 'first' | 'get' | 'eq' | 'not' | 'and' | 'or';

export type ComputeRef = Readonly<{
    path: string;
}>;

export type ComputeExpr = Readonly<{
    op: ComputeOp;
    args: readonly ComputeValue[];
}>;

export type ComputeValue =
    | Readonly<{literal: unknown}>
    | Readonly<{ref: ComputeRef}>
    | ComputeExpr;
