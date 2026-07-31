export type DslProgram = {
    imports?: DslImport[];
    body: DslStmt[];
};

export type DslImport = {
    kind: 'entity_rules';
    profileName: string;
    alias: string;
};

export type DslStmt = LetStmt | ActStmt | EntityActStmt | LinkedEntityActStmt | FormActStmt | TableActStmt | CheckpointStmt | IfStmt | ForStmt;

export type LetStmt = {
    kind: 'let';
    name: string;
    expr: DslExpr;
};

export type DslExpr = QueryExpr | EntityQueryExpr | QuerySugarExpr | RefExpr;

export type RefExpr = {
    kind: 'ref';
    ref: string;
};

export type QueryExpr = {
    kind: 'query';
    op: 'entity' | 'entity.target';
    businessTag: string;
    payload: unknown;
    profileName?: string;
};

export type EntityReference = {
    kind: 'entity_ref';
    alias: string;
    entityKey: string;
    member: string;
    rowValue?: RefExpr;
};

export type EntityQueryExpr = {
    kind: 'entity_query';
    reference: EntityReference;
};

export type QuerySugarExpr =
    | {
          kind: 'querySugar';
          target: 'table';
          businessTag: string;
          op: 'currentRows' | 'rowCount' | 'hasNextPage' | 'nextPageTarget';
      }
    | {
          kind: 'querySugar';
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
    profileName?: string;
};

export type EntityActStmt = {
    kind: 'entity_act';
    action: 'fill' | 'click' | 'type' | 'select';
    target: EntityReference;
    value?: RefExpr;
};

export type LinkedEntityActStmt = {
    kind: 'linked_entity_act';
    action: 'fill' | 'click' | 'type' | 'select';
    targetQuery: QueryExpr;
    value?: RefExpr;
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

export type TableActStmt = {
    kind: 'table_act';
    action: 'fill' | 'click';
    businessTag: string;
    target:
        | {
              kind: 'filter';
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
