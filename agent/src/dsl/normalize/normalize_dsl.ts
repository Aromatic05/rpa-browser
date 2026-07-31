import type {
    DslExpr,
    DslProgram,
    DslStmt,
    FormActStmt,
    LinkedEntityActStmt,
    QueryExpr,
    RefExpr,
    TableActStmt,
} from '../ast/types';

export const normalizeDsl = (program: DslProgram): DslProgram => ({
    imports: program.imports,
    body: normalizeStatements(program.body),
});

const normalizeStatements = (body: readonly DslStmt[]): DslStmt[] =>
    body.flatMap((stmt) => normalizeStmt(stmt));

const normalizeStmt = (stmt: DslStmt): DslStmt[] => {
    if (stmt.kind === 'let') {
        return [{...stmt, expr: normalizeExpr(stmt.expr)}];
    }
    if (stmt.kind === 'output') {
        return [{...stmt, expr: normalizeExpr(stmt.expr)}];
    }
    if (stmt.kind === 'form_act') {
        return [expandFormActStmt(stmt)];
    }
    if (stmt.kind === 'table_act') {
        return [expandTableActStmt(stmt)];
    }
    if (stmt.kind === 'linked_entity_act') {
        return [{
            ...stmt,
            targetQuery: normalizeQueryExpr(stmt.targetQuery),
            ...(stmt.value ? {value: normalizeRef(stmt.value)} : {}),
        }];
    }
    if (stmt.kind === 'act') {
        return [{
            ...stmt,
            ...(stmt.target ? {target: normalizeRef(stmt.target)} : {}),
            ...(stmt.value ? {value: normalizeRef(stmt.value)} : {}),
        }];
    }
    if (stmt.kind === 'resolve_act') {
        return [{
            ...stmt,
            ...(stmt.value ? {value: normalizeRef(stmt.value)} : {}),
        }];
    }
    if (stmt.kind === 'entity_act') {
        return [stmt];
    }
    if (stmt.kind === 'checkpoint') {
        return [{
            ...stmt,
            input: stmt.input
                ? Object.fromEntries(Object.entries(stmt.input).map(([key, value]) => [key, normalizeExpr(value)]))
                : undefined,
        }];
    }
    if (stmt.kind === 'if') {
        return [{
            ...stmt,
            condition: normalizeExpr(stmt.condition),
            then: normalizeStatements(stmt.then),
            else: stmt.else ? normalizeStatements(stmt.else) : undefined,
        }];
    }
    return [{
        ...stmt,
        iterable: normalizeExpr(stmt.iterable),
        body: normalizeStatements(stmt.body),
    }];
};

const normalizeExpr = <T extends DslExpr>(expr: T): T => {
    if (expr.kind === 'querySugar') {
        return expandQuerySugarExpr(expr) as T;
    }
    if (expr.kind === 'query') {
        return normalizeQueryExpr(expr) as T;
    }
    if (expr.kind !== 'ref') {return expr;}
    return normalizeRef(expr) as T;
};

const normalizeQueryExpr = (expr: QueryExpr): QueryExpr => ({
    ...expr,
    payload: normalizePayload(expr.payload),
});

const normalizePayload = (value: unknown): unknown => {
    if (isRefExpr(value)) {return normalizeRef(value);}
    if (Array.isArray(value)) {return value.map(normalizePayload);}
    if (!isRecord(value)) {return value;}
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizePayload(item)]));
};

const normalizeRef = (expr: RefExpr): RefExpr => {
    if (expr.ref.startsWith('input.') || expr.ref.startsWith('vars.') || expr.ref.startsWith('output.')) {
        return expr;
    }
    return {...expr, ref: `vars.${expr.ref}`};
};

const expandFormActStmt = (stmt: FormActStmt): LinkedEntityActStmt => ({
    kind: 'linked_entity_act',
    action: stmt.action,
    targetQuery: {
        kind: 'query',
        op: 'entity.target',
        businessTag: stmt.businessTag,
        payload: stmt.target.kind === 'field'
            ? {kind: 'form.field', fieldKey: stmt.target.fieldKey}
            : {kind: 'form.action', actionIntent: stmt.target.actionIntent},
    },
    ...(stmt.value ? {value: normalizeRef(stmt.value)} : {}),
});

const expandTableActStmt = (stmt: TableActStmt): LinkedEntityActStmt => ({
    kind: 'linked_entity_act',
    action: stmt.action,
    targetQuery: {
        kind: 'query',
        op: 'entity.target',
        businessTag: stmt.businessTag,
        payload: stmt.target.kind === 'filter'
            ? {kind: 'table.filter', fieldKey: stmt.target.fieldKey}
            : {kind: 'table.module_action', actionIntent: stmt.target.actionIntent},
    },
    ...(stmt.value ? {value: normalizeRef(stmt.value)} : {}),
});

const expandQuerySugarExpr = (
    expr: Extract<DslExpr, {kind: 'querySugar'}>,
): Extract<DslExpr, {kind: 'query'}> => expr.target === 'table'
    ? {
        kind: 'query',
        op: 'entity',
        businessTag: expr.businessTag,
        payload: `table.${expr.op}`,
    }
    : {
        kind: 'query',
        op: 'entity',
        businessTag: expr.businessTag,
        payload: `form.${expr.op}`,
    };

const isRefExpr = (value: unknown): value is RefExpr =>
    isRecord(value) && value.kind === 'ref' && typeof value.ref === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
