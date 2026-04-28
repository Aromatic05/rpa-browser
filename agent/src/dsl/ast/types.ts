export type DslProgram = {
    body: DslStmt[];
};

export type DslStmt = LetStmt | ActStmt | CheckpointStmt | IfStmt | ForStmt;

export type LetStmt = {
    kind: 'let';
    name: string;
    expr: DslExpr;
};

export type DslExpr = QueryExpr | RefExpr;

export type RefExpr = {
    kind: 'ref';
    ref: string;
};

export type QueryExpr = {
    kind: 'query';
    op: 'entity' | 'entity.target';
    businessTag: string;
    payload: unknown;
};

export type ActStmt = {
    kind: 'act';
    action: 'fill' | 'click';
    target: RefExpr;
    value?: RefExpr;
};

export type CheckpointStmt = {
    kind: 'checkpoint';
    id: string;
    input?: Record<string, DslExpr>;
};

export type IfStmt = {
    kind: 'if';
    condition: DslExpr;
    then: DslStmt[];
    else?: DslStmt[];
};

export type ForStmt = {
    kind: 'for';
    item: string;
    iterable: DslExpr;
    body: DslStmt[];
};
