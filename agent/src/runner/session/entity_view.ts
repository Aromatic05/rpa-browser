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
    bindingIds?: string[];
    itemNodeIds?: ObservationNodeId[];
    keySlot?: number;
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
    const suppressedEntityIds = new Set(bindings
        .map((binding) => readString(binding.annotation.suppressesEntityId))
        .filter((entityId): entityId is string => Boolean(entityId)));

    for (const form of Object.values(entry.capture.form.forms.forms)) {
        const nodeId = form.location.structuralRootNodeId;
        entities.push(componentEntity(entry, {
            id: `form:${form.id}`,
            nodeId,
            componentId: form.id,
            kind: 'form',
            bindings: compactBindings(
                preferredComponentBinding(bindings, form.id, 'form'),
                preferredNodeDecorationBinding(bindings, nodeId),
            ),
            memberBindings: formMemberBindings(bindings, form),
        }));
    }
    for (const table of Object.values(entry.capture.table.tables.tables)) {
        const nodeId = table.location.structuralRootNodeId;
        const componentBindings = compactBindings(
            preferredComponentBinding(bindings, table.id, 'table'),
            preferredNodeDecorationBinding(bindings, nodeId),
        );
        entities.push(componentEntity(entry, {
            id: `table:${table.id}`,
            nodeId,
            componentId: table.id,
            kind: 'table',
            bindings: componentBindings,
            memberBindings: tableMemberBindings(bindings, componentBindings),
        }));
    }
    for (const generic of structuralGenericEntities(entry)) {
        entities.push(componentEntity(entry, {
            id: `node:${generic.kind}:${generic.nodeId}`,
            nodeId: generic.nodeId,
            kind: generic.kind,
            bindings: compactBindings(
                preferredGenericBinding(bindings, generic.nodeId, generic.kind),
                preferredNodeDecorationBinding(bindings, generic.nodeId),
            ),
            itemNodeIds: generic.itemNodeIds,
            keySlot: generic.keySlot,
        }));
    }

    const representedBindingIds = new Set(entities.flatMap((entity) => entity.bindingIds ?? []));
    for (const binding of bindings) {
        if (representedBindingIds.has(binding.id)) {continue;}
        const entityKind = readEntityKind(binding.annotation.entityKind ?? binding.annotation.kind);
        const nodeId = binding.target.nodeIds[0];
        if (!entityKind || !nodeId) {continue;}
        entities.push(componentEntity(entry, {
            id: `binding:${binding.id}`,
            nodeId,
            kind: entityKind,
            bindings: compactBindings(binding, preferredNodeDecorationBinding(bindings, nodeId)),
        }));
    }

    const visibleEntities = entities.filter((entity) => !suppressedEntityIds.has(entity.id));
    visibleEntities.sort((left, right) => compareEntityOrder(entry, left, right));
    const byNodeId: Record<ObservationNodeId, PageSessionEntityRecord[]> = {};
    for (const entity of visibleEntities) {
        byNodeId[entity.nodeId] = [...(byNodeId[entity.nodeId] ?? []), entity];
    }
    return {entities: visibleEntities, byNodeId};
};

export const filterPageSessionEntities = (
    entities: readonly PageSessionEntityRecord[],
    filter: {
        kind?: RuntimeEntityKind | readonly RuntimeEntityKind[];
        businessTag?: string | readonly string[];
        query?: string;
    },
): PageSessionEntityRecord[] => {
    const kinds = normalizeFilterValues(filter.kind);
    const businessTags = normalizeFilterValues(filter.businessTag);
    const queryTokens = normalizeSearchTokens(filter.query);
    return entities.filter((entity) => {
        if (kinds.length > 0 && !kinds.includes(entity.kind)) {return false;}
        if (businessTags.length > 0 && (!entity.businessTag || !businessTags.includes(entity.businessTag))) {
            return false;
        }
        if (queryTokens.length > 0) {
            const haystackTokens = new Set(normalizeSearchTokens([
                entity.id,
                entity.kind,
                entity.name,
                entity.businessTag,
            ].filter(Boolean).join(' ')));
            if (!queryTokens.every((token) => haystackTokens.has(token))) {return false;}
        }
        return true;
    });
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
        const paginationNodeId = resolvedPaginationNode(entry, entity.componentId, entity.annotation);
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
        const targetMeta = target.kind === 'form.field'
            ? {...meta, ...selectOptionControlMeta(entry, nodeIds)}
            : meta;
        return uniqueNodeTarget(nodeIds, targetMeta, `${target.kind} ${expected}`);
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



const SELECT_OPTION_CONTROL_KINDS = new Set([
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
]);

const selectOptionControlMeta = (
    entry: PageSnapshotSessionEntry,
    nodeIds: readonly ObservationNodeId[],
): Record<string, unknown> => {
    const controlKinds = new Set<string>();
    for (const nodeId of nodeIds) {
        for (const controlId of entry.capture.control.controls.byNodeId[nodeId] ?? []) {
            const control = entry.capture.control.controls.controls[controlId];
            if (control.capabilities.includes('select_option') && SELECT_OPTION_CONTROL_KINDS.has(control.kind)) {
                controlKinds.add(control.kind);
            }
        }
    }
    return controlKinds.size === 1 ? {controlKind: [...controlKinds][0]} : {};
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
        bindings?: SemanticBusinessBinding[];
        memberBindings?: SemanticBusinessBinding[];
        itemNodeIds?: ObservationNodeId[];
        keySlot?: number;
    },
): PageSessionEntityRecord => {
    const bindings = [...(input.bindings ?? [])]
        .sort((left, right) => bindingPriority(left) - bindingPriority(right) || left.id.localeCompare(right.id));
    const annotation = bindings.reduce<Record<string, unknown>>(
        (merged, binding) => ({...merged, ...binding.annotation}),
        {},
    );
    if (input.kind === 'form') {enrichFormAnnotation(annotation, input.memberBindings ?? []);}
    if (input.kind === 'table') {enrichTableAnnotation(annotation, input.memberBindings ?? []);}
    const preferred = bindings.at(-1);
    return {
        id: input.id,
        nodeId: input.nodeId,
        componentId: input.componentId,
        kind: input.kind,
        name: readString(annotation.displayName)
            ?? readString(annotation.businessName)
            ?? readString(annotation.name)
            ?? readNodeName(entry, input.nodeId),
        businessTag: readString(annotation.businessTag),
        source: preferred?.origin ?? 'structural',
        bindingId: preferred?.id,
        bindingIds: [...bindings, ...(input.memberBindings ?? [])].map((binding) => binding.id),
        itemNodeIds: input.itemNodeIds ? [...input.itemNodeIds] : undefined,
        keySlot: input.keySlot,
        annotation: Object.keys(annotation).length > 0 ? annotation : undefined,
    };
};





type StructuralGenericEntity = {
    nodeId: ObservationNodeId;
    kind: Exclude<RuntimeEntityKind, 'form' | 'table'>;
    itemNodeIds?: ObservationNodeId[];
    keySlot?: number;
};

const structuralGenericEntities = (entry: PageSnapshotSessionEntry): StructuralGenericEntity[] => {
    const observation = entry.capture.control.observation;
    return Object.keys(observation.nodes)
        .filter((nodeId) => isActiveObservationNode(entry, nodeId))
        .sort((left, right) => observation.documentOrder[left] - observation.documentOrder[right])
        .flatMap((nodeId) => {
            const kind = explicitGenericKind(entry, nodeId);
            if (!kind) {return [];}
            const itemNodeIds = genericItemNodeIds(entry, nodeId, kind);
            return [{
                nodeId,
                kind,
                itemNodeIds: itemNodeIds.length > 0 ? itemNodeIds : undefined,
                keySlot: kind === 'list' || kind === 'kv' ? 0 : undefined,
            }];
        });
};

const explicitGenericKind = (
    entry: PageSnapshotSessionEntry,
    nodeId: ObservationNodeId,
): StructuralGenericEntity['kind'] | undefined => {
    const observation = entry.capture.control.observation;
    const role = normalizeLower(resolveSemanticRole(observation, nodeId).value);
    const tag = normalizeLower(observation.nodes[nodeId].tag);
    if (role === 'dialog' || role === 'alertdialog' || tag === 'dialog') {return 'dialog';}
    if (role === 'toolbar') {return 'toolbar';}
    if (role === 'list' || role === 'listbox' || role === 'menu' || role === 'tree' || tag === 'ul' || tag === 'ol') {
        return 'list';
    }
    if (role === 'region' || role === 'main' || role === 'complementary' || tag === 'main') {return 'panel';}
    if (tag === 'dl') {return 'kv';}
    return undefined;
};

const genericItemNodeIds = (
    entry: PageSnapshotSessionEntry,
    rootNodeId: ObservationNodeId,
    kind: StructuralGenericEntity['kind'],
): ObservationNodeId[] => {
    const observation = entry.capture.control.observation;
    if (kind === 'kv') {
        return observation.children[rootNodeId].filter((nodeId) =>
            normalizeLower(observation.nodes[nodeId].tag) === 'dt');
    }
    if (kind !== 'list') {return [];}
    const candidateItems = descendants(entry, rootNodeId).filter((nodeId) => {
        const role = normalizeLower(resolveSemanticRole(observation, nodeId).value);
        const tag = normalizeLower(observation.nodes[nodeId].tag);
        return role === 'listitem' || role === 'option' || role === 'menuitem' || role === 'treeitem' || tag === 'li';
    });
    const candidateSet = new Set(candidateItems);
    return candidateItems.filter((nodeId) => {
        let parentId = observation.parents[nodeId];
        while (parentId && parentId !== rootNodeId) {
            if (candidateSet.has(parentId)) {return false;}
            parentId = observation.parents[parentId];
        }
        return parentId === rootNodeId;
    });
};

const isActiveObservationNode = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean => {
    const activity = entry.capture.control.observation.activity[nodeId];
    return activity.rendered && activity.subtreeActive && !activity.hiddenByStyle && !activity.inert
        && activity.ariaExposed !== false;
};



const tableMemberBindings = (
    bindings: readonly SemanticBusinessBinding[],
    componentBindings: readonly SemanticBusinessBinding[],
): SemanticBusinessBinding[] => {
    const profileNames = new Set(componentBindings.map((binding) => binding.profileName));
    return bindings.filter((binding) => binding.domain === 'table' && profileNames.has(binding.profileName));
};

const enrichTableAnnotation = (
    annotation: Record<string, unknown>,
    bindings: readonly SemanticBusinessBinding[],
): void => {
    const next = bindings.find((binding) => binding.annotation.paginationRole === 'next'
        && binding.target.nodeIds.length === 1);
    const disabled = bindings.find((binding) => binding.annotation.paginationRole === 'next-disabled'
        && binding.target.nodeIds.length === 1);
    if (!next) {return;}
    const currentPagination = isRecord(annotation.pagination) ? annotation.pagination : {};
    const currentNext = isRecord(currentPagination.nextAction) ? currentPagination.nextAction : {};
    annotation.pagination = {
        ...currentPagination,
        nextAction: {
            ...currentNext,
            actionIntent: readString(next.annotation.actionIntent) ?? readString(currentNext.actionIntent) ?? 'next_page',
            nodeId: next.target.nodeIds[0],
            ...(disabled ? {disabledNodeId: disabled.target.nodeIds[0]} : {}),
        },
    };
};

const formMemberBindings = (
    bindings: readonly SemanticBusinessBinding[],
    form: PageSnapshotSessionEntry['capture']['form']['forms']['forms'][string],
): SemanticBusinessBinding[] => {
    const fieldIds = new Set(form.fields.map((field) => field.id));
    const actionIds = new Set(form.actions.map((action) => action.id));
    return bindings.filter((binding) =>
        binding.domain === 'form'
        && (binding.target.fieldIds.some((fieldId) => fieldIds.has(fieldId))
            || binding.target.actionIds.some((actionId) => actionIds.has(actionId))));
};

const enrichFormAnnotation = (
    annotation: Record<string, unknown>,
    bindings: readonly SemanticBusinessBinding[],
): void => {
    const formFields = bindings.flatMap((binding) => {
        const fieldKey = readString(binding.annotation.fieldKey);
        const nodeId = binding.target.nodeIds[0];
        if (!fieldKey || !nodeId) {return [];}
        return [{
            fieldKey,
            name: readString(binding.annotation.fieldName) ?? readString(binding.annotation.name),
            kind: readString(binding.annotation.controlKind) ?? readString(binding.annotation.kind),
            controlNodeId: nodeId,
        }];
    });
    const formActions = bindings.flatMap((binding) => {
        const actionIntent = readString(binding.annotation.actionIntent);
        const nodeId = binding.target.nodeIds[0];
        if (!actionIntent || !nodeId) {return [];}
        return [{
            actionIntent,
            text: readString(binding.annotation.actionText) ?? readString(binding.annotation.text),
            nodeId,
        }];
    });
    if (formFields.length > 0) {annotation.formFields = formFields;}
    if (formActions.length > 0) {annotation.formActions = formActions;}
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



const preferredGenericBinding = (
    bindings: readonly SemanticBusinessBinding[],
    nodeId: ObservationNodeId,
    kind: Exclude<RuntimeEntityKind, 'form' | 'table'>,
): SemanticBusinessBinding | undefined => bindings
    .filter((binding) => binding.target.nodeIds.includes(nodeId)
        && readEntityKind(binding.annotation.entityKind ?? binding.annotation.kind) === kind)
    .sort((left, right) => bindingPriority(right) - bindingPriority(left) || left.id.localeCompare(right.id))[0];

const preferredNodeDecorationBinding = (
    bindings: readonly SemanticBusinessBinding[],
    nodeId: ObservationNodeId,
): SemanticBusinessBinding | undefined => bindings
    .filter((binding) => binding.target.nodeIds.includes(nodeId)
        && (readString(binding.annotation.displayName) || readString(binding.annotation.name))
        && !readEntityKind(binding.annotation.entityKind ?? binding.annotation.kind)
        && !readString(binding.annotation.suppressesEntityId))
    .sort((left, right) => bindingPriority(right) - bindingPriority(left) || left.id.localeCompare(right.id))[0];

const compactBindings = (
    ...bindings: Array<SemanticBusinessBinding | undefined>
): SemanticBusinessBinding[] => bindings.filter((binding): binding is SemanticBusinessBinding => Boolean(binding));

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
    annotation: Readonly<Record<string, unknown>> | undefined,
): ObservationNodeId | undefined => {
    const pagination = new Map(Object.entries(entry.capture.table.tables.tables)).get(tableId)?.pagination;
    const structural = pagination?.status === 'resolved'
        ? pagination.nodeIds.find((nodeId) => isEnabledNode(entry, nodeId))
        : undefined;
    if (structural) {return structural;}
    const paginationAnnotation = isRecord(annotation?.pagination) ? annotation.pagination : undefined;
    const nextAction = paginationAnnotation && isRecord(paginationAnnotation.nextAction)
        ? paginationAnnotation.nextAction
        : undefined;
    const nodeId = readString(nextAction?.nodeId);
    const disabledNodeId = readString(nextAction?.disabledNodeId);
    if (!nodeId || !Object.hasOwn(entry.capture.control.observation.nodes, nodeId)) {return undefined;}
    if (disabledNodeId && !isEnabledNode(entry, disabledNodeId)) {return undefined;}
    return isEnabledNode(entry, nodeId) ? nodeId : undefined;
};

const isEnabledNode = (entry: PageSnapshotSessionEntry, nodeId: ObservationNodeId): boolean => {
    const attrs = entry.capture.control.observation.attributes[nodeId];
    const runtime = entry.capture.control.observation.runtimeState[nodeId];
    return attrs.disabled !== '' && attrs.disabled !== 'true'
        && attrs['aria-disabled'] !== 'true'
        && runtime?.disabled !== 'true';
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

const normalizeFilterValues = (value: string | readonly string[] | undefined): string[] => {
    if (typeof value === 'string') {return [value];}
    return value ? Array.from(value) : [];
};
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
const normalizeSearchTokens = (value: string | undefined): string[] =>
    normalizeLower(value).split(/[^\p{L}\p{N}]+/gu).filter(Boolean);
const cloneUnknown = <T>(value: T): T => structuredClone(value);
const notFound = (message: string): {ok: false; error: EntityOperationError} => ({
    ok: false,
    error: {code: 'ERR_NOT_FOUND', message},
});
const badArgs = (message: string): {ok: false; error: EntityOperationError} => ({
    ok: false,
    error: {code: 'ERR_BAD_ARGS', message},
});
