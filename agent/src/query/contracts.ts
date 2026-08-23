export type QueryFromRef =
    | 'snapshot'
    | 'snapshot.latest'
    | {nodeIds: string[]}
    | {
        nodes: Array<
            | {id: string}
            | {handle: {nodeId: string}}
        >;
    };

export type QueryWhere = Readonly<{
    role?: string;
    tag?: string;
    text?: Readonly<{contains?: string}>;
    attrs?: Readonly<Record<string, string>>;
}>;

export type BusinessQueryName =
    | 'table.rowCount'
    | 'table.headers'
    | 'table.primaryKey'
    | 'table.columns'
    | 'table.currentRows'
    | 'table.hasNextPage'
    | 'table.nextPageTarget'
    | 'form.fields'
    | 'form.actions';

export type BusinessTarget =
    | {kind: 'entity.field'; fieldKey: string}
    | {kind: 'entity.action'; actionIntent: string}
    | {kind: 'form.field'; fieldKey: string}
    | {kind: 'form.action'; actionIntent: string}
    | {kind: 'table.filter'; fieldKey: string}
    | {kind: 'table.module_action'; actionIntent: string}
    | {kind: 'table.row'; primaryKey: {fieldKey: string; value: string}}
    | {
        kind: 'table.row_action';
        primaryKey: {fieldKey: string; value: string};
        actionIntent: string;
    };

export type BrowserQueryRequest =
    | {
        from: QueryFromRef;
        where?: QueryWhere;
        relation?: 'child' | 'descendant';
        limit?: number;
    }
    | {
        op: 'entity';
        businessTag: string;
        query: BusinessQueryName;
    }
    | {
        op: 'entity.target';
        businessTag: string;
        target: BusinessTarget;
    };

export type QueryScanSource =
    | Readonly<{kind: 'roots'}>
    | Readonly<{kind: 'nodes'; nodeIds: readonly string[]}>;

export type QueryPredicate = Readonly<{
    active: true;
    roleEquals?: string;
    tagEquals?: string;
    textContains?: string;
    attrsEqual?: Readonly<Record<string, string>>;
}>;

export type QueryIR =
    | Readonly<{op: 'scan'; source: QueryScanSource}>
    | Readonly<{op: 'traverse'; input: QueryIR; relation: 'child' | 'descendant'}>
    | Readonly<{op: 'filter'; input: QueryIR; predicate: QueryPredicate}>
    | Readonly<{op: 'limit'; input: QueryIR; count: number}>
    | Readonly<{op: 'entity'; businessTag: string; query: BusinessQueryName}>
    | Readonly<{op: 'entity.target'; businessTag: string; target: BusinessTarget}>;

export type QueryCompileResult =
    | Readonly<{ok: true; ir: QueryIR}>
    | Readonly<{ok: false; error: Readonly<{code: 'ERR_BAD_ARGS'; message: string}>}>;
