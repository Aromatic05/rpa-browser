import type {
    BusinessQueryName,
    BusinessTarget,
    QueryCompileResult,
    QueryIR,
    QueryPredicate,
    QueryScanSource,
} from './contracts';

export const MAX_QUERY_LIMIT = 500;

const BUSINESS_QUERIES = new Set<BusinessQueryName>([
    'table.rowCount',
    'table.headers',
    'table.primaryKey',
    'table.columns',
    'table.currentRows',
    'table.hasNextPage',
    'table.nextPageTarget',
    'form.fields',
    'form.actions',
]);

export const compileBrowserQuery = (request: unknown): QueryCompileResult => {
    if (!isRecord(request)) {return badArgs('query must be an object');}
    if ('op' in request) {return compileBusiness(request);}
    if (!('from' in request)) {return badArgs('from is required');}

    const source = compileSource(request.from);
    if (!source.ok) {return source;}
    const relation = request.relation ?? 'descendant';
    if (relation !== 'child' && relation !== 'descendant') {
        return badArgs('relation must be child or descendant');
    }
    const limit = request.limit ?? MAX_QUERY_LIMIT;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0 || limit > MAX_QUERY_LIMIT) {
        return badArgs(`limit must be an integer between 1 and ${MAX_QUERY_LIMIT}`);
    }
    const predicate = compilePredicate(request.where);
    if (!predicate.ok) {return predicate;}

    const scan: QueryIR = Object.freeze({op: 'scan', source: source.source});
    const traverse: QueryIR = Object.freeze({op: 'traverse', relation, input: scan});
    const filter: QueryIR = Object.freeze({op: 'filter', predicate: predicate.predicate, input: traverse});
    return Object.freeze({
        ok: true as const,
        ir: Object.freeze({op: 'limit', count: limit, input: filter}),
    });
};

const compileBusiness = (request: Record<string, unknown>): QueryCompileResult => {
    const businessTag = string(request.businessTag);
    if (!businessTag) {return badArgs('businessTag is required');}
    if (request.op === 'entity') {
        if (typeof request.query !== 'string' || !BUSINESS_QUERIES.has(request.query as BusinessQueryName)) {
            return badArgs('unsupported business query');
        }
        return Object.freeze({
            ok: true as const,
            ir: Object.freeze({
                op: 'entity' as const,
                businessTag,
                query: request.query as BusinessQueryName,
            }),
        });
    }
    if (request.op !== 'entity.target') {return badArgs('op must be entity or entity.target');}
    const target = compileBusinessTarget(request.target);
    if (!target) {return badArgs('invalid business target');}
    return Object.freeze({
        ok: true as const,
        ir: Object.freeze({
            op: 'entity.target' as const,
            businessTag,
            target: structuredClone(target),
        }),
    });
};

const compileSource = (
    from: unknown,
): {ok: true; source: QueryScanSource} | Extract<QueryCompileResult, {ok: false}> => {
    if (typeof from === 'string') {
        if (from !== 'snapshot' && from !== 'snapshot.latest') {
            return badArgs('from must be snapshot or snapshot.latest');
        }
        return {ok: true, source: Object.freeze({kind: 'roots'})};
    }
    if (!isRecord(from)) {return badArgs('unsupported from type');}
    if ('nodeIds' in from) {
        if (!Array.isArray(from.nodeIds) || from.nodeIds.length === 0
            || from.nodeIds.some((nodeId) => typeof nodeId !== 'string')) {
            return badArgs('from.nodeIds must be a non-empty string array');
        }
        return {
            ok: true,
            source: Object.freeze({
                kind: 'nodes',
                nodeIds: Object.freeze([...new Set(from.nodeIds as string[])]),
            }),
        };
    }
    if ('nodes' in from) {
        if (!Array.isArray(from.nodes) || from.nodes.length === 0) {
            return badArgs('from.nodes must be a non-empty array');
        }
        const nodeIds = from.nodes.flatMap((item) => {
            if (!isRecord(item)) {return [];}
            if (typeof item.id === 'string') {return [item.id];}
            const handle = isRecord(item.handle) ? item.handle : undefined;
            return typeof handle?.nodeId === 'string' ? [handle.nodeId] : [];
        });
        return {
            ok: true,
            source: Object.freeze({kind: 'nodes', nodeIds: Object.freeze([...new Set(nodeIds)])}),
        };
    }
    return badArgs('unsupported from type');
};

const compilePredicate = (
    value: unknown,
): {ok: true; predicate: QueryPredicate} | Extract<QueryCompileResult, {ok: false}> => {
    if (value !== undefined && !isRecord(value)) {return badArgs('where must be an object');}
    const where = value;
    const predicate: {
        active: true;
        roleEquals?: string;
        tagEquals?: string;
        textContains?: string;
        attrsEqual?: Readonly<Record<string, string>>;
    } = {active: true};
    if (where?.role !== undefined) {
        if (typeof where.role !== 'string') {return badArgs('where.role must be a string');}
        if (where.role) {predicate.roleEquals = where.role;}
    }
    if (where?.tag !== undefined) {
        if (typeof where.tag !== 'string') {return badArgs('where.tag must be a string');}
        if (where.tag) {predicate.tagEquals = where.tag;}
    }
    if (where?.text !== undefined) {
        if (!isRecord(where.text)) {return badArgs('where.text must be an object');}
        if (where.text.contains !== undefined && typeof where.text.contains !== 'string') {
            return badArgs('where.text.contains must be a string');
        }
        if (where.text.contains) {predicate.textContains = where.text.contains;}
    }
    if (where?.attrs !== undefined) {
        if (!isRecord(where.attrs) || Object.values(where.attrs).some((item) => typeof item !== 'string')) {
            return badArgs('where.attrs must be a string map');
        }
        predicate.attrsEqual = Object.freeze({...where.attrs as Record<string, string>});
    }
    return {ok: true, predicate: Object.freeze(predicate)};
};

const compileBusinessTarget = (value: unknown): BusinessTarget | null => {
    if (!isRecord(value) || typeof value.kind !== 'string') {return null;}
    if (value.kind === 'entity.field' || value.kind === 'form.field' || value.kind === 'table.filter') {
        return typeof value.fieldKey === 'string' ? {kind: value.kind, fieldKey: value.fieldKey} : null;
    }
    if (value.kind === 'entity.action' || value.kind === 'form.action' || value.kind === 'table.module_action') {
        return typeof value.actionIntent === 'string'
            ? {kind: value.kind, actionIntent: value.actionIntent}
            : null;
    }
    const primaryKey = isRecord(value.primaryKey) ? value.primaryKey : undefined;
    if (!primaryKey || typeof primaryKey.fieldKey !== 'string' || typeof primaryKey.value !== 'string') {return null;}
    if (value.kind === 'table.row') {
        return {kind: 'table.row', primaryKey: {fieldKey: primaryKey.fieldKey, value: primaryKey.value}};
    }
    if (value.kind === 'table.row_action' && typeof value.actionIntent === 'string') {
        return {
            kind: 'table.row_action',
            primaryKey: {fieldKey: primaryKey.fieldKey, value: primaryKey.value},
            actionIntent: value.actionIntent,
        };
    }
    return null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const string = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

const badArgs = (message: string): Extract<QueryCompileResult, {ok: false}> => Object.freeze({
    ok: false as const,
    error: Object.freeze({code: 'ERR_BAD_ARGS' as const, message}),
});
