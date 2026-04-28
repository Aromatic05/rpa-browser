export type DslProgram = {
    body: DslStmt[];
};

export type DslStmt = LetStmt | ActStmt | FormActStmt | CheckpointStmt | IfStmt | ForStmt;

export type LetStmt = {
    kind: 'let';
    name: string;
    expr: DslExpr;
};

export type DslExpr = QueryExpr | QuerySugarExpr | RefExpr;

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

export type QuerySugarExpr =
    | {
          kind: 'query_sugar';
          target: 'table';
          businessTag: string;
          op: 'current_rows' | 'row_count' | 'has_next_page' | 'next_page_target';
      }
    | {
          kind: 'query_sugar';
          target: 'form';
          businessTag: string;
          op: 'fields' | 'actions';
      };

export type ActStmt = {
    kind: 'act';
    action: 'fill' | 'click' | 'type' | 'select' | 'wait' | 'snapshot';
    target?: RefExpr;
    value?: RefExpr;
    durationMs?: number;
};

export type FormActStmt = {
    kind: 'form_act';
    action: 'fill' | 'click';
    businessTag: string;
    target:
        | {
              kind: 'field';
              fieldKey: string;
          }
        | {
              kind: 'action';
              actionIntent: string;
          };
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
