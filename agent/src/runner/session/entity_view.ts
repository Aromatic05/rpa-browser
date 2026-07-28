import {
    resolveSemanticRole,
    type ObservationNodeId,
    type PageSnapshotSessionEntry,
    type SemanticBusinessBinding,
} from '../../snapshot';

export type RuntimeEntityKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';

export type PageSessionEntityRecord = {
    id: string;
    nodeId: ObservationNodeId;
    componentId?: string;
    kind: RuntimeEntityKind;
    name?: string;
    businessTag?: string;
    source: 'structural' | 'inferred' | 'confirmed' | 'manual';
    bindingId?: string;
    annotation?: Readonly<Record<string, unknown>>;
};

export type PageSessionEntityView = {
    entities: PageSessionEntityRecord[];
    byNodeId: Readonly<Record<ObservationNodeId, readonly PageSessionEntityRecord[]>>;
};

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
    | {kind: 'form.field'; fieldKey: string}
    | {kind: 'form.action'; actionIntent: string}
    | {kind: 'table.row'; primaryKey: {fieldKey: string; value: string}}
    | {
        kind: 'table.row_action';
        primaryKey: {fieldKey: string; value: string};
        actionIntent: string;
    };

type EntityOperationError = {
    code: 'ERR_NOT_FOUND' | 'ERR_AMBIGUOUS' | 'ERR_BAD_ARGS';
    message: string;
    details?: unknown;
};

type EntityOperationResult<T> = {ok: true; data: T} | {ok: false; error: EntityOperationError};

export const buildPageSessionEntityView = (
    entry: PageSnapshotSessionEntry,
): PageSessionEntityView => {
    const bindings = activeBindings(entry);
    const entities: PageSessionEntityRecord[] = [];

    for (const form of Object.values(entry.capture.form.forms.forms)) {
        const binding = preferredComponentBinding(bindings, form.id, 'form');
        entities.push(componentEntity(entry, {
            id: `form:${form.id}`,
            nodeId: form.location.structuralRootNodeId,
            componentId: form.id,
            kind: 'form',
            binding,
        }));
    }
    for (const table of Object.values(entry.capture.table.tables.tables)) {
        const binding = preferredComponentBinding(bindings, table.id, 'table');
        entities.push(componentEntity(entry, {
            id: `table:${table.id}`,
            nodeId: table.location.structuralRootNodeId,
            componentId: table.id,
            kind: 'table',
            binding,
        }));
    }

    const representedBindingIds = new Set(entities.map((entity) => entity.bindingId).filter(Boolean));
    for (const binding of bindings) {
        if (representedBindingIds.has(binding.id)) {continue;}
        const entityKind = readEntityKind(binding.annotation.entityKind ?? binding.annotation.kind);
        const nodeId = binding.target.nodeIds[0];
        if (!entityKind || !nodeId) {continue;}
        entities.push(componentEntity(entry, {
            id: `binding:${binding.id}`,
            nodeId,
            kind: entityKind,
            binding,
        }));
    }

    entities.sort((left, right) => compareEntityOrder(entry, left, right));
    const byNodeId: Record<ObservationNodeId, PageSessionEntityRecord[]> = {};
    for (const entity of entities) {
        byNodeId[entity.nodeId] = [...(byNodeId[entity.nodeId] ?? []), entity];
    }
    return {entities, byNodeId};
};

export const queryPageSessionBusinessEntity = (
    entry: PageSnapshotSessionEntry,
    businessTag: string,
    query: BusinessQueryName,
): EntityOperationResult<{
    kind: 'value' | 'nodeId';
    value?: unknown;
    nodeId?: ObservationNodeId;
    meta: Record<string, unknown>;
}> => {
    const resolved = resolveBusinessEntity(entry, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;
    const meta = {
        businessTag,
        entityId: entity.id,
        entityKind: entity.kind,
        componentId: entity.componentId,
    };

    if (query.startsWith('table.')) {
        if (entity.kind !== 'table' || !entity.componentId) {
            return badArgs(`Business entity ${businessTag} is not a table.`);
        }
        const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(entity.componentId);
        if (!table) {return notFound(`Table component ${entity.componentId} is unavailable.`);}
        if (query === 'table.rowCount') {
            return {ok: true, data: {kind: 'value', value: table.body.visibleRows.length, meta}};
        }
        if (query === 'table.headers') {
            return {ok: true, data: {kind: 'value', value: table.columns.map((column) => column.name), meta}};
        }
        if (query === 'table.primaryKey') {
            return {ok: true, data: {kind: 'value', value: entity.annotation?.primaryKey, meta}};
        }
        if (query === 'table.columns') {
            return {
                ok: true,
                data: {
                    kind: 'value',
                    value: Array.isArray(entity.annotation?.columns)
                        ? cloneUnknown(entity.annotation.columns)
                        : table.columns.map((column) => ({id: column.id, index: column.index, name: column.name})),
                    meta,
                },
            };
        }
        if (query === 'table.currentRows') {
            return {ok: true, data: {kind: 'value', value: currentRows(entry, entity.componentId, entity.annotation), meta}};
        }
        const paginationNodeId = resolvedPaginationNode(entry, entity.componentId);
        if (query === 'table.hasNextPage') {
            return {ok: true, data: {kind: 'value', value: Boolean(paginationNodeId), meta}};
        }
        if (!paginationNodeId) {return notFound(`Table ${businessTag} has no resolved next-page target.`);}
        return {ok: true, data: {kind: 'nodeId', nodeId: paginationNodeId, meta}};
    }

    if (entity.kind !== 'form' || !entity.componentId) {
        return badArgs(`Business entity ${businessTag} is not a form.`);
    }
    const form = new Map(Object.entries(entry.capture.form.forms.forms)).get(entity.componentId);
    if (!form) {return notFound(`Form component ${entity.componentId} is unavailable.`);}
    if (query === 'form.fields') {
        return {
            ok: true,
            data: {
                kind: 'value',
                value: Array.isArray(entity.annotation?.formFields)
                    ? cloneUnknown(entity.annotation.formFields)
                    : form.fields.map((field) => ({
                        id: field.id,
                        controlIds: [...field.controlIds],
                        required: field.required,
                    })),
                meta,
            },
        };
    }
    if (query === 'form.actions') {
        return {
            ok: true,
            data: {
                kind: 'value',
                value: Array.isArray(entity.annotation?.formActions)
                    ? cloneUnknown(entity.annotation.formActions)
                    : form.actions.map((action) => ({
                        id: action.id,
                        nodeId: action.nodeId,
                        structuralRole: action.structuralRole,
                    })),
                meta,
            },
        };
    }
    return badArgs(`Query ${query} is incompatible with form entity ${businessTag}.`);
};

export const resolvePageSessionBusinessTarget = (
    entry: PageSnapshotSessionEntry,
    businessTag: string,
    target: BusinessTarget,
): EntityOperationResult<{
    kind: 'nodeId';
    nodeId: ObservationNodeId;
    meta: Record<string, unknown>;
}> => {
    const resolved = resolveBusinessEntity(entry, businessTag);
    if (!resolved.ok) {return resolved;}
    const entity = resolved.data;
    const meta = {
        businessTag,
        entityId: entity.id,
        entityKind: entity.kind,
        targetKind: target.kind,
    };

    if (target.kind === 'form.field' || target.kind === 'form.action') {
        if (entity.kind !== 'form') {return badArgs(`Business entity ${businessTag} is not a form.`);}
        const records = target.kind === 'form.field'
            ? entity.annotation?.formFields
            : entity.annotation?.formActions;
        const key = target.kind === 'form.field' ? 'fieldKey' : 'actionIntent';
        const expected = target.kind === 'form.field' ? target.fieldKey : target.actionIntent;
        const matches = arrayRecords(records).filter((record) => record[key] === expected);
        const nodeIds = matches
            .map((record) => readString(record.controlNodeId) ?? readString(record.nodeId))
            .filter((nodeId): nodeId is string => Boolean(nodeId));
        return uniqueNodeTarget(nodeIds, meta, `${target.kind} ${expected}`);
    }

    if (entity.kind !== 'table' || !entity.componentId) {
        return badArgs(`Business entity ${businessTag} is not a table.`);
    }
    const row = resolveTableRow(entry, entity, target.primaryKey);
    if (!row.ok) {return row;}
    if (target.kind === 'table.row') {
        return {ok: true, data: {kind: 'nodeId', nodeId: row.data.nodeId, meta}};
    }

    const actionText = resolveActionText(entity.annotation, target.actionIntent);
    if (!actionText) {
        return notFound(`Action intent ${target.actionIntent} is not declared for ${businessTag}.`);
    }
    const candidates = descendants(entry, row.data.nodeId)
        .filter((nodeId) => {
            const role = resolveSemanticRole(entry.capture.control.observation, nodeId).value;
            return (role === 'button' || role === 'link')
                && normalizeLower(readNodeSearchText(entry, nodeId)).includes(normalizeLower(actionText));
        });
    return uniqueNodeTarget(candidates, meta, `table row action ${target.actionIntent}`);
};

const resolveBusinessEntity = (
    entry: PageSnapshotSessionEntry,
    businessTag: string,
): EntityOperationResult<PageSessionEntityRecord> => {
    const normalized = normalizeText(businessTag);
    if (!normalized) {return badArgs('businessTag is required.');}
    const matches = buildPageSessionEntityView(entry).entities
        .filter((entity) => entity.businessTag === normalized);
    if (matches.length === 0) {return notFound(`Business entity ${normalized} was not found.`);}
    if (matches.length > 1) {
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: `Business entity ${normalized} matched multiple components.`,
                details: {entityIds: matches.map((entity) => entity.id)},
            },
        };
    }
    return {ok: true, data: matches[0]};
};

const componentEntity = (
    entry: PageSnapshotSessionEntry,
    input: {
        id: string;
        nodeId: ObservationNodeId;
        componentId?: string;
        kind: RuntimeEntityKind;
        binding?: SemanticBusinessBinding;
    },
): PageSessionEntityRecord => {
    const annotation = input.binding?.annotation;
    return {
        id: input.id,
        nodeId: input.nodeId,
        componentId: input.componentId,
        kind: input.kind,
        name: readString(annotation?.displayName)
            ?? readString(annotation?.name)
            ?? readNodeName(entry, input.nodeId),
        businessTag: readString(annotation?.businessTag),
        source: input.binding?.origin ?? 'structural',
        bindingId: input.binding?.id,
        annotation,
    };
};

const activeBindings = (entry: PageSnapshotSessionEntry): SemanticBusinessBinding[] =>
    Object.values(entry.semanticBindingsByProfile)
        .flatMap((bindings) => Object.values(bindings.byId))
        .filter((binding) => binding.status === 'active' && binding.disposition === 'active');

const preferredComponentBinding = (
    bindings: readonly SemanticBusinessBinding[],
    componentId: string,
    domain: 'form' | 'table',
): SemanticBusinessBinding | undefined => bindings
    .filter((binding) => binding.domain === domain && binding.target.componentIds.includes(componentId))
    .sort((left, right) => bindingPriority(right) - bindingPriority(left) || left.id.localeCompare(right.id))[0];

const bindingPriority = (binding: SemanticBusinessBinding): number => {
    if (binding.origin === 'manual') {return 3;}
    if (binding.origin === 'confirmed') {return 2;}
    return 1;
};

const currentRows = (
    entry: PageSnapshotSessionEntry,
    tableId: string,
    annotation: Readonly<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> => {
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(tableId);
    if (!table) {return [];}
    const cells = new Map(Object.entries(entry.capture.table.tables.cells));
    const columns = new Map(Object.entries(entry.capture.table.tables.columns));
    const columnMeta = arrayRecords(annotation?.columns);
    return table.body.visibleRows.map((row) => {
        const record: Record<string, unknown> = {rowId: row.id, nodeId: row.nodeId, key: row.key};
        for (const cellId of row.cellIds) {
            const cell = cells.get(cellId);
            if (!cell) {continue;}
            const column = columns.get(cell.columnId);
            const metadata = columnMeta.find((item) => item.name === column?.name);
            const key = readString(metadata?.fieldKey) ?? column?.name ?? cell.columnId;
            record[key] = cell.text;
        }
        return record;
    });
};

const resolvedPaginationNode = (
    entry: PageSnapshotSessionEntry,
    tableId: string,
): ObservationNodeId | undefined => {
    const pagination = new Map(Object.entries(entry.capture.table.tables.tables)).get(tableId)?.pagination;
    if (pagination?.status !== 'resolved') {return undefined;}
    return pagination.nodeIds.find((nodeId) => {
        const attrs = entry.capture.control.observation.attributes[nodeId];
        const runtime = entry.capture.control.observation.runtimeState[nodeId];
        return attrs.disabled !== '' && attrs.disabled !== 'true'
            && attrs['aria-disabled'] !== 'true'
            && runtime?.disabled !== 'true';
    });
};

const resolveTableRow = (
    entry: PageSnapshotSessionEntry,
    entity: PageSessionEntityRecord,
    primaryKey: {fieldKey: string; value: string},
): EntityOperationResult<{nodeId: ObservationNodeId}> => {
    if (!entity.componentId) {return badArgs(`Entity ${entity.id} has no table component.`);}
    const table = new Map(Object.entries(entry.capture.table.tables.tables)).get(entity.componentId);
    if (!table) {return notFound(`Table component ${entity.componentId} is unavailable.`);}
    const cells = new Map(Object.entries(entry.capture.table.tables.cells));
    const columnName = resolvePrimaryKeyColumnName(entity.annotation, primaryKey.fieldKey);
    if (!columnName) {
        return notFound(`Primary key field ${primaryKey.fieldKey} is not declared for ${entity.businessTag}.`);
    }
    const column = table.columns.find((candidate) => normalizeLower(candidate.name) === normalizeLower(columnName));
    if (!column) {return notFound(`Primary key column ${columnName} is unavailable.`);}
    const rows = table.body.visibleRows.filter((row) => row.cellIds.some((cellId) => {
        const cell = cells.get(cellId);
        return cell?.columnId === column.id && normalizeText(cell.text) === normalizeText(primaryKey.value);
    }));
    if (rows.length === 0) {return notFound(`Primary key value ${primaryKey.value} was not found.`);}
    if (rows.length > 1) {
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: `Primary key value ${primaryKey.value} matched multiple rows.`,
                details: {rowIds: rows.map((row) => row.id)},
            },
        };
    }
    return {ok: true, data: {nodeId: rows[0].nodeId}};
};

const resolvePrimaryKeyColumnName = (
    annotation: Readonly<Record<string, unknown>> | undefined,
    fieldKey: string,
): string | undefined => {
    const metadata = arrayRecords(annotation?.columns)
        .find((column) => column.fieldKey === fieldKey);
    if (metadata) {return readString(metadata.name);}
    const primaryKey = isRecord(annotation?.primaryKey) ? annotation.primaryKey : undefined;
    if (primaryKey?.fieldKey !== fieldKey || !Array.isArray(primaryKey.columns)) {return undefined;}
    return primaryKey.columns.map(readString).find(Boolean);
};

const resolveActionText = (
    annotation: Readonly<Record<string, unknown>> | undefined,
    actionIntent: string,
): string | undefined => arrayRecords(annotation?.columns)
    .flatMap((column) => arrayRecords(column.actions))
    .find((action) => action.actionIntent === actionIntent)
    ?.text as string | undefined;

const uniqueNodeTarget = (
    nodeIds: readonly ObservationNodeId[],
    meta: Record<string, unknown>,
    description: string,
): EntityOperationResult<{kind: 'nodeId'; nodeId: ObservationNodeId; meta: Record<string, unknown>}> => {
    const unique = [...new Set(nodeIds)];
    if (unique.length === 0) {return notFound(`${description} was not found.`);}
    if (unique.length > 1) {
        return {
            ok: false,
            error: {
                code: 'ERR_AMBIGUOUS',
                message: `${description} matched multiple nodes.`,
                details: {nodeIds: unique},
            },
        };
    }
    return {ok: true, data: {kind: 'nodeId', nodeId: unique[0], meta}};
};

const descendants = (
    entry: PageSnapshotSessionEntry,
    rootNodeId: ObservationNodeId,
): ObservationNodeId[] => {
    const out: ObservationNodeId[] = [];
    const stack = [...entry.capture.control.observation.children[rootNodeId]];
    while (stack.length > 0) {
        const current = stack.shift()!;
        out.push(current);
        stack.unshift(...entry.capture.control.observation.children[current]);
    }
    return out;
};

const readNodeName = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
    const attrs = observation.attributes[nodeId];
    return normalizeText(observation.accessibility[nodeId]?.name)
        ?? normalizeText(attrs['aria-label'])
        ?? normalizeText(attrs.title)
        ?? normalizeText(attrs.id)
        ?? readNodeText(entry, nodeId);
};

const readNodeSearchText = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined =>
    normalizeText([readNodeName(entry, nodeId), readNodeText(entry, nodeId)].filter(Boolean).join(' '));

const readNodeText = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): string | undefined => {
    const observation = entry.capture.control.observation;
    const values: string[] = [];
    const stack = [nodeId];
    while (stack.length > 0) {
        const current = stack.shift()!;
        const text = normalizeText(observation.text[current]);
        if (text && !values.includes(text)) {values.push(text);}
        stack.unshift(...observation.children[current]);
    }
    return normalizeText(values.join(' '));
};

const compareEntityOrder = (
    entry: PageSnapshotSessionEntry,
    left: PageSessionEntityRecord,
    right: PageSessionEntityRecord,
): number => (entry.capture.control.observation.documentOrder[left.nodeId] ?? Number.MAX_SAFE_INTEGER)
    - (entry.capture.control.observation.documentOrder[right.nodeId] ?? Number.MAX_SAFE_INTEGER)
    || left.id.localeCompare(right.id);

const readEntityKind = (value: unknown): RuntimeEntityKind | undefined =>
    typeof value === 'string' && ['form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv'].includes(value)
        ? value as RuntimeEntityKind
        : undefined;

const arrayRecords = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? value.filter(isRecord) : [];
const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const readString = (value: unknown): string | undefined => typeof value === 'string' ? normalizeText(value) : undefined;
const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = value?.replace(/\s+/g, ' ').trim();
    return normalized || undefined;
};
const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase() ?? '';
const cloneUnknown = <T>(value: T): T => structuredClone(value);
const notFound = (message: string): {ok: false; error: EntityOperationError} => ({
    ok: false,
    error: {code: 'ERR_NOT_FOUND', message},
});
const badArgs = (message: string): {ok: false; error: EntityOperationError} => ({
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});
