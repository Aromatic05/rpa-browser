import { buildExternalIndexes } from '../indexes/external_indexes';
import { snapshotDebugLog } from './debug';
import { dedupeEntityRuleDiagnostics } from './diagnostics';
import { buildBusinessBindingIndex } from './entity_query';
import { cloneTreeWithRuntime, getNodeContent, normalizeText } from './runtime_store';
import { buildTableStructureModel } from './table_model';
import type {
    EntityIndex,
    EntityBusinessInfo,
    EntityKind,
    EntityRecord,
    EntityRuleDiagnostic,
    FinalEntityRecord,
    FinalEntityView,
    GroupEntity,
    NodeEntityRef,
    RegionEntity,
    SnapshotOverlayAddEntity,
    SnapshotOverlayDeleteEntity,
    SnapshotOverlays,
    SnapshotResult,
} from './types';

const GROUP_ONLY_KINDS = new Set<EntityKind>(['kv']);

export const applySnapshotOverlay = (baseSnapshot: SnapshotResult, overlays: SnapshotOverlays): SnapshotResult => {
    const snapshot = cloneSnapshot(baseSnapshot);
    const renamedCount = applyRenameOverlay(snapshot, overlays.renamedNodes);
    const addResult = applyAddEntityOverlay(snapshot, overlays.addedEntities);
    const deletedCount = applyDeleteEntityOverlay(snapshot, overlays.deletedEntities);

    snapshotDebugLog('overlay-apply', {
        baseEntityCount: Object.keys(baseSnapshot.entityIndex.entities).length,
        finalEntityCount: Object.keys(snapshot.entityIndex.entities).length,
        renameCount: renamedCount,
        deleteCount: deletedCount,
        addCount: addResult.applied,
        addSkipped: addResult.skipped,
    });

    return snapshot;
};

export const buildFinalEntityViewFromSnapshot = (
    finalSnapshot: SnapshotResult,
    overlays: SnapshotOverlays,
    composedFromBase = false,
): FinalEntityView => {
    const renamedByNodeId = buildRenamedByNodeId(overlays.renamedNodes);
    const addedNameByNodeId = buildAddedNameByNodeId(overlays.addedEntities);
    const entities = Object.values(finalSnapshot.entityIndex.entities)
        .map((entity) => toFinalEntityRecord(finalSnapshot, entity, renamedByNodeId, addedNameByNodeId))
        .filter((entity): entity is FinalEntityRecord => Boolean(entity))
        .sort((left, right) => {
            if (left.nodeId !== right.nodeId) {return left.nodeId.localeCompare(right.nodeId);}
            if (left.kind !== right.kind) {return left.kind.localeCompare(right.kind);}
            return left.id.localeCompare(right.id);
        });

    const byNodeId: FinalEntityView['byNodeId'] = {};
    for (const entity of entities) {
        const bucket = byNodeId[entity.nodeId] || [];
        bucket.push(entity);
        byNodeId[entity.nodeId] = bucket;
    }

    snapshotDebugLog('overlay-final-view', {
        entityCount: entities.length,
        nodeCount: Object.keys(byNodeId).length,
        composedFromBase,
    });

    const diagnostics = buildFinalEntityDiagnostics(finalSnapshot, entities);

    return {
        entities,
        byNodeId,
        bindingIndex: buildBusinessBindingIndex(entities),
        diagnostics,
    };
};

const applyRenameOverlay = (
    snapshot: SnapshotResult,
    renamedNodes: Record<string, string>,
): number => {
    const renamedByNodeId = buildRenamedByNodeId(renamedNodes);
    let applied = 0;

    for (const [nodeId, renamed] of Object.entries(renamedByNodeId)) {
        if (!Object.prototype.hasOwnProperty.call(snapshot.nodeIndex, nodeId)) {continue;}
        const node = snapshot.nodeIndex[nodeId];
        node.name = renamed;
        applied += 1;
    }

    for (const entity of Object.values(snapshot.entityIndex.entities)) {
        if (entity.type === 'region') {
            const renamed = renamedByNodeId[entity.nodeId];
            if (!renamed) {continue;}
            entity.name = renamed;
            continue;
        }
        const renamed = renamedByNodeId[entity.containerId];
        if (!renamed) {continue;}
        entity.name = renamed;
    }

    return applied;
};

const applyDeleteEntityOverlay = (
    snapshot: SnapshotResult,
    deletedEntities: SnapshotOverlayDeleteEntity[],
): number => {
    if (deletedEntities.length === 0) {return 0;}

    const deletions = normalizeDeletions(deletedEntities);
    if (deletions.length === 0) {return 0;}

    const toDeleteEntityIds = new Set<string>();
    for (const entity of Object.values(snapshot.entityIndex.entities)) {
        const entityNodeId = getEntityNodeId(entity);
        if (!entityNodeId) {continue;}

        if (deletions.some((item) => matchesDeletion(entity, entityNodeId, item))) {
            toDeleteEntityIds.add(entity.id);
        }
    }

    if (toDeleteEntityIds.size === 0) {return 0;}

    for (const entityId of toDeleteEntityIds) {
        delete snapshot.entityIndex.entities[entityId];
    }

    for (const [nodeId, refs] of Object.entries(snapshot.entityIndex.byNodeId)) {
        const filtered = (refs || []).filter((ref) => !toDeleteEntityIds.has(ref.entityId));
        if (filtered.length === 0) {
            delete snapshot.entityIndex.byNodeId[nodeId];
            continue;
        }
        snapshot.entityIndex.byNodeId[nodeId] = filtered;
    }

    return toDeleteEntityIds.size;
};

const applyAddEntityOverlay = (
    snapshot: SnapshotResult,
    addedEntities: SnapshotOverlayAddEntity[],
): { applied: number; skipped: number } => {
    if (addedEntities.length === 0) {return { applied: 0, skipped: 0 };}

    let applied = 0;
    let skipped = 0;
    const usedIds = new Set(Object.keys(snapshot.entityIndex.entities));

    for (let index = 0; index < addedEntities.length; index += 1) {
        const added = addedEntities[index];
        const nodeId = normalizeText(added.nodeId);
        if (!nodeId || !Object.prototype.hasOwnProperty.call(snapshot.nodeIndex, nodeId)) {
            skipped += 1;
            continue;
        }

        const id = nextOverlayEntityId(usedIds, added.kind, index);
        const name = normalizeText(added.name);
        const businessTag = normalizeText(added.businessTag);

        if (resolveAddedEntityType(snapshot, nodeId, added.kind) === 'group' && isGroupEntityKind(added.kind)) {
            const entity: GroupEntity = {
                id,
                type: 'group',
                kind: added.kind,
                containerId: nodeId,
                itemIds: [],
                keySlot: 0,
                name,
                businessTag,
                source: 'overlay_add',
            };
            snapshot.entityIndex.entities[id] = entity;
            pushNodeRef(snapshot.entityIndex.byNodeId, nodeId, {
                type: 'group',
                entityId: id,
                role: 'container',
            });
            applied += 1;
            continue;
        }

        if (!isRegionEntityKind(added.kind)) {
            skipped += 1;
            continue;
        }

        const entity: RegionEntity = {
            id,
            type: 'region',
            kind: added.kind,
            nodeId,
            name,
            businessTag,
            source: 'overlay_add',
            bbox: snapshot.bboxIndex[nodeId],
        };
        snapshot.entityIndex.entities[id] = entity;
        pushNodeRef(snapshot.entityIndex.byNodeId, nodeId, {
            type: 'region',
            entityId: id,
            role: 'container',
        });
        applied += 1;
    }

    return { applied, skipped };
};

const cloneSnapshot = (baseSnapshot: SnapshotResult): SnapshotResult => {
    const root = cloneTreeWithRuntime(baseSnapshot.root);
    const external = buildExternalIndexes(root);

    return {
        root,
        nodeIndex: external.nodeIndex,
        entityIndex: cloneEntityIndex(baseSnapshot.entityIndex),
        locatorIndex: baseSnapshot.locatorIndex,
        bboxIndex: external.bboxIndex,
        attrIndex: external.attrIndex,
        contentStore: external.contentStore,
        cacheStats: baseSnapshot.cacheStats,
        ruleEntityOverlay: baseSnapshot.ruleEntityOverlay || baseSnapshot.businessEntityOverlay,
        businessEntityOverlay: baseSnapshot.businessEntityOverlay || baseSnapshot.ruleEntityOverlay,
    };
};

const buildFinalEntityDiagnostics = (snapshot: SnapshotResult, entities: FinalEntityRecord[]): EntityRuleDiagnostic[] | undefined => {
    const baseDiagnostics = [
        ...((snapshot.ruleEntityOverlay?.diagnostics || snapshot.businessEntityOverlay?.diagnostics || []).map((item) => ({
            ...item,
            nodeIds: item.nodeIds ? [...item.nodeIds] : undefined,
            details: item.details ? { ...item.details } : undefined,
        }))),
    ];
    const derivedDiagnostics = entities.flatMap((entity) => deriveEntityDiagnostics(snapshot, entity));
    const diagnostics = dedupeEntityRuleDiagnostics([...baseDiagnostics, ...derivedDiagnostics]);
    return diagnostics.length > 0 ? diagnostics : undefined;
};

const deriveEntityDiagnostics = (snapshot: SnapshotResult, entity: FinalEntityRecord): EntityRuleDiagnostic[] => {
    if (entity.kind !== 'table' || !entity.columns || entity.columns.length === 0) {
        return [];
    }

    const model = buildTableStructureModel(snapshot, entity.nodeId);
    if (!model) {return [];}

    const diagnostics: EntityRuleDiagnostic[] = [];
    for (const column of entity.columns) {
        const headerMatched = resolveColumnIndexAgainstModel(model, column) >= 0;
        if (!headerMatched) {
            diagnostics.push({
                code: 'TABLE_COLUMN_HEADER_UNRESOLVED',
                level: 'warning',
                message: `table column header unresolved: ${column.name || column.fieldKey}`,
                entityId: entity.id,
                businessTag: entity.businessTag,
                fieldKey: column.fieldKey,
                columnName: column.name,
                nodeIds: [entity.nodeId],
            });
            if (column.kind === 'action_column') {
                for (const action of column.actions || []) {
                    diagnostics.push({
                        code: 'TABLE_ACTION_COLUMN_UNRESOLVED',
                        level: 'warning',
                        message: `table action column unresolved: ${action.actionIntent}`,
                        entityId: entity.id,
                        businessTag: entity.businessTag,
                        fieldKey: column.fieldKey,
                        columnName: column.name,
                        actionIntent: action.actionIntent,
                        nodeIds: [entity.nodeId],
                    });
                }
            }
        }
    }
    return diagnostics;
};

const resolveColumnIndexAgainstModel = (
    model: NonNullable<ReturnType<typeof buildTableStructureModel>>,
    column: { columnIndex?: number; name?: string },
): number => {
    if (typeof column.columnIndex === 'number' && column.columnIndex >= 0 && column.columnIndex < model.headers.length) {
        return column.columnIndex;
    }
    if (!column.name) {return -1;}
    return model.headers.findIndex((header) => normalizeLower(header) === normalizeLower(column.name));
};

const cloneEntityIndex = (entityIndex: EntityIndex): EntityIndex => {
    const entities: EntityIndex['entities'] = {};
    for (const [id, entity] of Object.entries(entityIndex.entities)) {
        entities[id] = cloneEntity(entity);
    }

    const byNodeId: EntityIndex['byNodeId'] = {};
    for (const [nodeId, refs] of Object.entries(entityIndex.byNodeId)) {
        if (!refs || refs.length === 0) {continue;}
        byNodeId[nodeId] = refs.map((ref) => ({ ...ref }));
    }

    return {
        entities,
        byNodeId,
    };
};

const cloneEntity = (entity: EntityRecord): EntityRecord => {
    if (entity.type === 'region') {
        return {
            ...entity,
            bbox: entity.bbox ? { ...entity.bbox } : undefined,
            keyHint: entity.keyHint
                ? {
                    ...entity.keyHint,
                    sampleValues: entity.keyHint.sampleValues ? [...entity.keyHint.sampleValues] : undefined,
                }
                : undefined,
        };
    }

    return {
        ...entity,
        itemIds: [...entity.itemIds],
        keyHint: entity.keyHint
            ? {
                ...entity.keyHint,
                sampleValues: entity.keyHint.sampleValues ? [...entity.keyHint.sampleValues] : undefined,
            }
            : undefined,
    };
};

const normalizeDeletions = (items: SnapshotOverlayDeleteEntity[]): SnapshotOverlayDeleteEntity[] => {
    const normalized: SnapshotOverlayDeleteEntity[] = [];
    for (const item of items) {
        const nodeId = normalizeText(item.nodeId);
        if (!nodeId) {continue;}
        normalized.push({
            nodeId,
            kind: item.kind,
            businessTag: normalizeText(item.businessTag),
        });
    }
    return normalized;
};

const buildRenamedByNodeId = (renamedNodes: Record<string, string>): Record<string, string> => {
    const next: Record<string, string> = {};
    for (const [nodeIdRaw, renamedRaw] of Object.entries(renamedNodes)) {
        const nodeId = normalizeText(nodeIdRaw);
        const renamed = normalizeText(renamedRaw);
        if (!nodeId || !renamed) {continue;}
        next[nodeId] = renamed;
    }
    return next;
};

const buildAddedNameByNodeId = (addedEntities: SnapshotOverlayAddEntity[]): Map<string, string> => {
    const addedNameByNodeId = new Map<string, string>();
    for (const added of addedEntities) {
        const nodeId = normalizeText(added.nodeId);
        const name = normalizeText(added.name);
        if (!nodeId || !name) {continue;}
        addedNameByNodeId.set(nodeId, name);
    }
    return addedNameByNodeId;
};

const toFinalEntityRecord = (
    snapshot: SnapshotResult,
    entity: EntityRecord,
    renamedByNodeId: Record<string, string>,
    addedNameByNodeId: Map<string, string>,
): FinalEntityRecord | null => {
    const nodeId = getEntityNodeId(entity);
    if (!nodeId) {return null;}
    const name = resolveEntityName(snapshot, entity, nodeId, renamedByNodeId, addedNameByNodeId);
    const businessInfo = resolveEntityBusinessInfo(snapshot, entity);
    const source = entity.source === 'overlay_add' ? 'overlay_add' : 'auto';

    if (entity.type === 'group') {
        return {
            id: buildFinalEntityId(entity, nodeId),
            entityId: entity.id,
            nodeId,
            kind: entity.kind,
            type: 'group',
            name,
            businessTag: normalizeText(businessInfo.businessTag),
            businessName: normalizeText(businessInfo.businessName),
            primaryKey: businessInfo.primaryKey
                ? {
                    fieldKey: businessInfo.primaryKey.fieldKey,
                    columns: businessInfo.primaryKey.columns ? [...businessInfo.primaryKey.columns] : undefined,
                    source: businessInfo.primaryKey.source,
                }
                : undefined,
            columns: businessInfo.columns?.map((column) => ({
                ...column,
                actions: column.actions?.map((action) => ({ ...action })),
            })),
            formFields: businessInfo.formFields?.map((field) => ({
                ...field,
                optionSource: field.optionSource ? { ...field.optionSource } : undefined,
            })),
            formActions: businessInfo.formActions?.map((action) => ({ ...action })),
            tableMeta: businessInfo.tableMeta
                ? {
                    ...businessInfo.tableMeta,
                    headers: [...businessInfo.tableMeta.headers],
                    rowNodeIds: [...businessInfo.tableMeta.rowNodeIds],
                    cellNodeIdsByRowNodeId: { ...businessInfo.tableMeta.cellNodeIdsByRowNodeId },
                    columnCellNodeIdsByHeader: { ...businessInfo.tableMeta.columnCellNodeIdsByHeader },
                    primaryKeyCandidates: businessInfo.tableMeta.primaryKeyCandidates.map((item) => ({
                        ...item,
                        columns: [...item.columns],
                    })),
                    recommendedPrimaryKey: businessInfo.tableMeta.recommendedPrimaryKey
                        ? [...businessInfo.tableMeta.recommendedPrimaryKey]
                        : undefined,
                }
                : undefined,
            source,
            itemIds: [...entity.itemIds],
            keySlot: entity.keySlot,
        };
    }

    return {
        id: buildFinalEntityId(entity, nodeId),
        entityId: entity.id,
        nodeId,
        kind: entity.kind,
        type: 'region',
        name,
        businessTag: normalizeText(businessInfo.businessTag),
        businessName: normalizeText(businessInfo.businessName),
        primaryKey: businessInfo.primaryKey
            ? {
                fieldKey: businessInfo.primaryKey.fieldKey,
                columns: businessInfo.primaryKey.columns ? [...businessInfo.primaryKey.columns] : undefined,
                source: businessInfo.primaryKey.source,
            }
            : undefined,
        columns: businessInfo.columns?.map((column) => ({
            ...column,
            actions: column.actions?.map((action) => ({ ...action })),
        })),
        formFields: businessInfo.formFields?.map((field) => ({
            ...field,
            optionSource: field.optionSource ? { ...field.optionSource } : undefined,
        })),
        formActions: businessInfo.formActions?.map((action) => ({ ...action })),
        tableMeta: businessInfo.tableMeta
            ? {
                ...businessInfo.tableMeta,
                headers: [...businessInfo.tableMeta.headers],
                rowNodeIds: [...businessInfo.tableMeta.rowNodeIds],
                cellNodeIdsByRowNodeId: { ...businessInfo.tableMeta.cellNodeIdsByRowNodeId },
                columnCellNodeIdsByHeader: { ...businessInfo.tableMeta.columnCellNodeIdsByHeader },
                primaryKeyCandidates: businessInfo.tableMeta.primaryKeyCandidates.map((item) => ({
                    ...item,
                    columns: [...item.columns],
                })),
                recommendedPrimaryKey: businessInfo.tableMeta.recommendedPrimaryKey
                    ? [...businessInfo.tableMeta.recommendedPrimaryKey]
                    : undefined,
            }
            : undefined,
        source,
    };
};

const resolveEntityBusinessInfo = (snapshot: SnapshotResult, entity: EntityRecord): EntityBusinessInfo => {
    const autoInfo = resolveAutoEntityBusinessInfo(snapshot, entity);
    const ruleOverlay = snapshot.ruleEntityOverlay || snapshot.businessEntityOverlay;
    const ruleInfo = ruleOverlay?.byEntityId[entity.id];
    const columns = ruleInfo?.columns
        ? ruleInfo.columns.map((column) => ({ ...column, actions: column.actions?.map((action) => ({ ...action })) }))
        : autoInfo.columns
          ? autoInfo.columns.map((column) => ({ ...column, actions: column.actions?.map((action) => ({ ...action })) }))
          : undefined;
    const formFields = ruleInfo?.formFields
        ? ruleInfo.formFields.map((field) => ({ ...field, optionSource: field.optionSource ? { ...field.optionSource } : undefined }))
        : autoInfo.formFields
          ? autoInfo.formFields.map((field) => ({ ...field, optionSource: field.optionSource ? { ...field.optionSource } : undefined }))
          : inferFormFieldsFromColumns(snapshot, entity, columns);
    const formActions = ruleInfo?.formActions
        ? ruleInfo.formActions.map((action) => ({ ...action }))
        : autoInfo.formActions
          ? autoInfo.formActions.map((action) => ({ ...action }))
          : inferFormActions(snapshot, entity);
    return {
        businessTag: ruleInfo?.businessTag || autoInfo.businessTag || entity.businessTag,
        businessName: ruleInfo?.businessName ?? autoInfo.businessName,
        primaryKey: ruleInfo?.primaryKey
            ? {
                fieldKey: ruleInfo.primaryKey.fieldKey,
                columns: ruleInfo.primaryKey.columns ? [...ruleInfo.primaryKey.columns] : undefined,
                source: ruleInfo.primaryKey.source,
            }
            : autoInfo.primaryKey
              ? {
                  fieldKey: autoInfo.primaryKey.fieldKey,
                  columns: autoInfo.primaryKey.columns ? [...autoInfo.primaryKey.columns] : undefined,
                  source: autoInfo.primaryKey.source,
              }
              : undefined,
        columns,
        formFields,
        formActions,
        tableMeta: ruleInfo?.tableMeta
            ? {
                ...ruleInfo.tableMeta,
                headers: [...ruleInfo.tableMeta.headers],
                rowNodeIds: [...ruleInfo.tableMeta.rowNodeIds],
                cellNodeIdsByRowNodeId: { ...ruleInfo.tableMeta.cellNodeIdsByRowNodeId },
                columnCellNodeIdsByHeader: { ...ruleInfo.tableMeta.columnCellNodeIdsByHeader },
                primaryKeyCandidates: ruleInfo.tableMeta.primaryKeyCandidates.map((item) => ({ ...item, columns: [...item.columns] })),
                recommendedPrimaryKey: ruleInfo.tableMeta.recommendedPrimaryKey ? [...ruleInfo.tableMeta.recommendedPrimaryKey] : undefined,
            }
            : autoInfo.tableMeta,
    };
};

const resolveAutoEntityBusinessInfo = (snapshot: SnapshotResult, entity: EntityRecord): EntityBusinessInfo => {
    const nodeId = getEntityNodeId(entity);
    if (!nodeId || entity.kind !== 'table') {
        return {};
    }

    const model = buildTableStructureModel(snapshot, nodeId);
    if (!model) {return {};}

    const headers = model.headers;
    const columns = headers.map((header, index) => ({
        fieldKey: header,
        name: header,
        source: 'table_meta' as const,
        columnIndex: index,
        headerNodeId: model.headerNodeIds[index],
    }));
    const recommendedHeader = model.recommendedPrimaryKey?.[0];
    const primaryKey = recommendedHeader
        ? {
            fieldKey: recommendedHeader,
            columns: [recommendedHeader],
            source: 'table_meta' as const,
        }
        : undefined;

    return {
        primaryKey,
        columns,
        tableMeta: {
            rowCount: model.rows.length,
            columnCount: model.columnCount,
            headers: [...model.headers],
            rowNodeIds: model.rows.map((row) => row.nodeId),
            cellNodeIdsByRowNodeId: Object.fromEntries(
                model.rows.map((row) => [row.nodeId, row.cells.map((cell) => cell.nodeId)]),
            ),
            columnCellNodeIdsByHeader: { ...model.columnCellNodeIdsByHeader },
            primaryKeyCandidates: model.primaryKeyCandidates.map((item) => ({
                columns: [...item.columns],
                unique: item.unique,
                duplicateCount: item.duplicateCount,
            })),
            recommendedPrimaryKey: model.recommendedPrimaryKey ? [...model.recommendedPrimaryKey] : undefined,
        },
    };
};

const inferFormFieldsFromColumns = (
    snapshot: SnapshotResult,
    entity: EntityRecord,
    columns: EntityBusinessInfo['columns'],
): EntityBusinessInfo['formFields'] | undefined => {
    if (entity.kind !== 'form' || !columns || columns.length === 0) {return undefined;}
    const formNode = snapshot.nodeIndex[getEntityNodeId(entity)];
    if (!formNode) {return undefined;}

    const remainingControls = walkDescendants(formNode)
        .filter((node) => isFormControl(node, snapshot))
        .map((node) => ({
            node,
            label: readFormControlLabel(node, snapshot),
        }));
    if (remainingControls.length === 0) {return undefined;}

    const fields: NonNullable<EntityBusinessInfo['formFields']> = [];
    for (const column of columns) {
        const matchedIndex = remainingControls.findIndex((candidate) => matchesFormFieldCandidate(candidate.label, column));
        const picked = matchedIndex >= 0 ? remainingControls.splice(matchedIndex, 1)[0] : remainingControls.shift();
        if (!picked) {continue;}
        fields.push({
            fieldKey: column.fieldKey,
            name: column.name,
            kind: inferFormFieldKind(picked.node, snapshot),
            controlNodeId: picked.node.id,
        });
    }

    return fields.length > 0 ? fields : undefined;
};

const inferFormActions = (
    snapshot: SnapshotResult,
    entity: EntityRecord,
): EntityBusinessInfo['formActions'] | undefined => {
    if (entity.kind !== 'form') {return undefined;}
    const formNode = snapshot.nodeIndex[getEntityNodeId(entity)];
    if (!formNode) {return undefined;}

    const actions: NonNullable<EntityBusinessInfo['formActions']> = [];
    for (const node of walkDescendants(formNode)) {
        if (normalizeLower(node.role) !== 'button') {continue;}
        const text = normalizeText(node.name || getNodeContent(node));
        const actionIntent = inferFormActionIntent(text);
        if (!actionIntent) {continue;}
        actions.push({
            actionIntent,
            text,
            nodeId: node.id,
        });
    }

    return actions.length > 0 ? actions : undefined;
};

const walkDescendants = (root: SnapshotResult['root']): SnapshotResult['root'][] => {
    const out: SnapshotResult['root'][] = [];
    const stack = [...root.children].reverse();
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {break;}
        out.push(node);
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return out;
};

const isFormControl = (node: SnapshotResult['root'], snapshot: SnapshotResult): boolean => {
    const role = normalizeLower(node.role);
    if (role === 'textbox' || role === 'spinbutton' || role === 'combobox') {return true;}
    const attrs = snapshot.attrIndex[node.id] || {};
    const tag = normalizeLower(attrs.tag || attrs.tagName);
    return tag === 'input' || tag === 'textarea' || tag === 'select';
};

const readFormControlLabel = (node: SnapshotResult['root'], snapshot: SnapshotResult): string => {
    const attrs = snapshot.attrIndex[node.id] || {};
    return [
        normalizeText(node.name),
        normalizeText(attrs.placeholder),
        normalizeText(getNodeContent(node)),
    ]
        .filter((value): value is string => Boolean(value))
        .join(' ');
};

const matchesFormFieldCandidate = (label: string, column: NonNullable<EntityBusinessInfo['columns']>[number]): boolean => {
    const haystack = normalizeLower(label);
    return haystack.includes(normalizeLower(column.name)) || haystack.includes(normalizeLower(column.fieldKey));
};

const inferFormFieldKind = (
    node: SnapshotResult['root'],
    snapshot: SnapshotResult,
): NonNullable<EntityBusinessInfo['formFields']>[number]['kind'] => {
    const role = normalizeLower(node.role);
    if (role === 'combobox') {return 'select';}
    const attrs = snapshot.attrIndex[node.id] || {};
    const tag = normalizeLower(attrs.tag || attrs.tagName);
    if (tag === 'textarea') {return 'textarea';}
    return 'input';
};

const inferFormActionIntent = (text: string | undefined): string | undefined => {
    const normalized = normalizeLower(text);
    if (!normalized) {return undefined;}
    if (normalized.includes('提交')) {return 'submit';}
    if (normalized.includes('重置')) {return 'reset';}
    if (normalized.includes('取消')) {return 'cancel';}
    return undefined;
};

const normalizeLower = (value: string | undefined): string => normalizeText(value)?.toLowerCase().replace(/\s+/g, '') || '';

const resolveEntityName = (
    snapshot: SnapshotResult,
    entity: EntityRecord,
    nodeId: string,
    renamedByNodeId: Record<string, string>,
    addedNameByNodeId: Map<string, string>,
): string | undefined => {
    const renamed = renamedByNodeId[nodeId];
    if (renamed) {return renamed;}

    const addedName = addedNameByNodeId.get(nodeId);
    if (addedName) {return addedName;}

    const entityName = normalizeText(entity.name);
    if (entityName) {return entityName;}

    const node = snapshot.nodeIndex[nodeId];
    const nodeName = normalizeText(node.name);
    if (nodeName) {return nodeName;}

    return normalizeText(getNodeContent(node));
};

const getEntityNodeId = (entity: EntityRecord): string => {
    return entity.type === 'group' ? entity.containerId : entity.nodeId;
};

const nextOverlayEntityId = (usedIds: Set<string>, kind: EntityKind, index: number): string => {
    const normalizedKind = kind.replace(/[^a-zA-Z0-9_]/g, '_');
    let suffix = String(index + 1).padStart(4, '0');
    let candidate = `ent_overlay_${normalizedKind}_${suffix}`;
    while (usedIds.has(candidate)) {
        suffix = `${suffix}_x`;
        candidate = `ent_overlay_${normalizedKind}_${suffix}`;
    }
    usedIds.add(candidate);
    return candidate;
};

const buildFinalEntityId = (entity: EntityRecord, nodeId: string): string => {
    return entity.source === 'overlay_add' ? `final_${entity.id}` : `final_${entity.id}_${nodeId}`;
};

const matchesDeletion = (
    entity: EntityRecord,
    entityNodeId: string,
    deletion: SnapshotOverlayDeleteEntity,
): boolean => {
    if (entityNodeId !== deletion.nodeId) {return false;}
    if (deletion.kind && deletion.kind !== entity.kind) {return false;}

    const entityBusinessTag = normalizeText(entity.businessTag);
    const deletionBusinessTag = normalizeText(deletion.businessTag);
    if (deletionBusinessTag && deletionBusinessTag !== entityBusinessTag) {return false;}

    return true;
};

const pushNodeRef = (
    byNodeId: EntityIndex['byNodeId'],
    nodeId: string,
    ref: NodeEntityRef,
) => {
    const current = byNodeId[nodeId] || [];
    if (current.some((item) => isSameRef(item, ref))) {
        byNodeId[nodeId] = current;
        return;
    }
    current.push(ref);
    byNodeId[nodeId] = current;
};

const isSameRef = (left: NodeEntityRef, right: NodeEntityRef): boolean => {
    return (
        left.type === right.type &&
        left.entityId === right.entityId &&
        left.role === right.role &&
        left.itemId === right.itemId &&
        left.slotIndex === right.slotIndex
    );
};

const resolveAddedEntityType = (
    snapshot: SnapshotResult,
    nodeId: string,
    kind: EntityKind,
): 'group' | 'region' => {
    const refs = snapshot.entityIndex.byNodeId[nodeId] || [];
    for (const ref of refs) {
        const entity = snapshot.entityIndex.entities[ref.entityId];
        if (entity.kind !== kind) {continue;}
        return entity.type;
    }
    if (GROUP_ONLY_KINDS.has(kind)) {return 'group';}
    return 'region';
};

const isGroupEntityKind = (kind: EntityKind): kind is GroupEntity['kind'] => {
    return kind === 'table' || kind === 'kv' || kind === 'list';
};

const isRegionEntityKind = (kind: EntityKind): kind is RegionEntity['kind'] => {
    return kind === 'form' || kind === 'table' || kind === 'dialog' || kind === 'list' || kind === 'panel' || kind === 'toolbar';
};
