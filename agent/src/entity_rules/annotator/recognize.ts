import {
    getNodeAttr,
    getNodeContent,
    normalizeText,
} from '../../runner/steps/executors/snapshot/core/runtime_store';
import type {
    EntityKind,
    FinalEntityView,
    FinalEntityRecord,
    SnapshotResult,
    UnifiedNode,
} from '../../runner/steps/executors/snapshot/core/types';
import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CanvasPageDraft,
} from './types';
import { entityCanvasId } from './identifiers';
import type { RecognizedItem } from './runtime_types';
import { buildNodeIndex, buildParentById, countMatches, isDescendantOrSelf } from './picking';
import { protectiveMerge } from './merge';

export const inferPageKind = (finalEntityView: FinalEntityView | undefined): EntityKind => {
    if (!finalEntityView) {
        return 'form';
    }
    const counts = new Map<EntityKind, number>();
    for (const entity of finalEntityView.entities) {
        if (entity.type !== 'region') {
            continue;
        }
        counts.set(entity.kind, (counts.get(entity.kind) || 0) + 1);
    }
    if (counts.size === 0) {
        return 'form';
    }
    let best: EntityKind = 'form';
    let bestCount = 0;
    for (const [kind, count] of counts) {
        if (count > bestCount) {
            best = kind;
            bestCount = count;
        }
    }
    return best;
};

const buildEntityTarget = (entity: FinalEntityRecord): CanvasEntityDraft['target'] => {
    const target: CanvasEntityDraft['target'] = { kind: entity.kind };
    const name = normalizeText(entity.name);
    if (name) {
        target.nameContains = name;
    }
    return target;
};

const buildNodeTarget = (
    snapshot: SnapshotResult,
    nodeId: string | undefined,
    options: {allowText?: boolean} = {},
): CanvasEntityDraft['target'] => {
    if (!nodeId) {return {};}
    const node = snapshot.nodeIndex[nodeId];
    if (!node) {return {};}
    const id = normalizeText(getNodeAttr(node, 'id'));
    if (id) {return {idEquals: id};}
    const name = normalizeText(getNodeAttr(node, 'name'));
    if (name) {return {nameEquals: name};}
    const aria = normalizeText(getNodeAttr(node, 'aria-label') || getNodeAttr(node, 'title'));
    if (aria) {return {ariaContains: aria};}
    const className = normalizeText(getNodeAttr(node, 'class'));
    const classToken = className?.split(/\s+/).find((token) => token.length >= 2 && !/[0-9a-f]{8,}/i.test(token));
    if (classToken) {return {classContains: classToken};}
    const text = normalizeText(node.name || getNodeContent(node));
    if (options.allowText && text && text.length <= 24) {return {textContains: text};}
    const role = normalizeText(node.role);
    return role ? {roleEquals: role} : {};
};

const collectControlsInSubtree = (snapshot: SnapshotResult, rootNodeId: string): UnifiedNode[] => {
    const parentById = buildParentById(snapshot.root);
    const out: UnifiedNode[] = [];
    const interactiveRoles = new Set([
        'button',
        'link',
        'textbox',
        'combobox',
        'checkbox',
        'radio',
        'searchbox',
    ]);
    for (const node of Object.values(snapshot.nodeIndex)) {
        if (!isDescendantOrSelf(node.id, rootNodeId, parentById)) {
            continue;
        }
        const role = (normalizeText(node.role) || '').toLowerCase();
        if (node.control || interactiveRoles.has(role)) {
            out.push(node);
        }
    }
    return out;
};

const inferFormFieldsFromControls = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
): CanvasAnnotationDraft[] => {
    const controls = collectControlsInSubtree(snapshot, entity.nodeId);
    const annotations: CanvasAnnotationDraft[] = [];
    const nodes = buildNodeIndex(snapshot.root);
    const parentById = buildParentById(snapshot.root);
    let index = 0;
    for (const control of controls) {
        const role = (normalizeText(control.role) || '').toLowerCase();
        if (role === 'button' || role === 'link') {
            continue;
        }
        const parent = parentById.get(control.id);
        const parentName = parent ? normalizeText(nodes.get(parent)?.name) : undefined;
        const label = normalizeText(parentName || getNodeContent(control));
        const fieldKey = normalizeText(label) || `field_${index}`;
        annotations.push({
            id: `auto_${entity.id}_field_${index}`,
            type: 'field',
            businessKey: fieldKey,
            ...(label ? { name: label } : {}),
            target: {},
            expect: 'unique',
            origin: 'inferred',
            disposition: 'active',
        });
        index += 1;
    }
    return annotations;
};

const buildInferredEntity = (
    snapshot: SnapshotResult,
    entity: FinalEntityRecord,
    index: number,
): CanvasEntityDraft => {
    const id = entityCanvasId(index);
    const inferredFields = inferFormFieldsFromControls(snapshot, entity);
    const annotations =
        (entity.formFields || []).length > 0 || (entity.formActions || []).length > 0
            ? [
                  ...(entity.formFields || []).map((field, fieldIndex) => ({
                      id: `auto_${id}_field_${fieldIndex}`,
                      type: 'field' as const,
                      businessKey: field.fieldKey,
                      ...(field.name ? { name: field.name } : {}),
                      target: buildNodeTarget(snapshot, field.controlNodeId),
                      expect: 'unique' as const,
                      origin: 'inferred' as const,
                      disposition: 'active' as const,
                  })),
                  ...(entity.formActions || []).map((action) => ({
                      id: `auto_${id}_action_${action.actionIntent}`,
                      type: 'action' as const,
                      businessKey: action.actionIntent,
                      ...(action.text ? {name: action.text} : {}),
                      target: buildNodeTarget(snapshot, action.nodeId, {allowText: true}),
                      expect: 'unique' as const,
                      origin: 'inferred' as const,
                      disposition: 'active' as const,
                  })),
              ]
            : inferredFields;

    return {
        id,
        source: entity.type === 'group' ? 'group' : 'region',
        kind: entity.kind,
        name: normalizeText(entity.businessName || entity.name) || entity.id,
        businessTag: normalizeText(entity.businessTag) || `${entity.kind}.${entity.id}`,
        target: buildEntityTarget(entity),
        expect: 'unique',
        annotations,
        columns:
            entity.columns?.map((column, colIndex) => ({
                id: `${id}_col${colIndex}`,
                fieldKey: column.fieldKey,
                ...(column.name ? { name: column.name } : {}),
                ...(column.kind ? { kind: column.kind } : {}),
                actions:
                    column.actions?.map((action, actionIndex) => ({
                        id: `${id}_col${colIndex}_act${actionIndex}`,
                        actionIntent: action.actionIntent,
                        ...(action.text ? { text: action.text } : {}),
                        target: {},
                        origin: 'inferred',
                        disposition: 'active',
                    })) || [],
                origin: 'inferred',
                disposition: 'active',
            })) || [],
        ...(entity.primaryKey
            ? {
                  primaryKey: {
                      fieldKey: entity.primaryKey.fieldKey,
                      ...(entity.primaryKey.columns
                          ? { columns: [...entity.primaryKey.columns] }
                          : {}),
                  },
              }
            : {}),
        ...(entity.pagination?.nextAction
            ? {
                  pagination: {
                      actionIntent: entity.pagination.nextAction.actionIntent,
                      pageTarget: buildNodeTarget(
                          snapshot,
                          entity.pagination.nextAction.nodeId,
                          {allowText: true},
                      ),
                  },
              }
            : {}),
        origin: 'inferred',
    };
};

const isSignificantEntity = (entity: FinalEntityRecord): boolean => {
    if (entity.type === 'group') {
        return (entity.itemIds || []).length > 0;
    }
    return entity.kind === 'form' || entity.kind === 'table' || entity.kind === 'list';
};

const summarizeEntity = (
    entity: CanvasEntityDraft,
    origin: 'inferred' | 'existing',
): RecognizedItem => ({
    entityId: entity.id,
    kind: entity.kind,
    name: normalizeText(entity.name),
    fieldCount: entity.annotations.filter((annotation) => annotation.type === 'field').length,
    columnCount: entity.columns.length,
    actionCount:
        entity.annotations.filter((annotation) => annotation.type === 'action').length +
        entity.columns.reduce((sum, column) => sum + column.actions.length, 0),
    origin,
});

const buildFreshInferredEntities = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
): CanvasEntityDraft[] => {
    const significantEntities = (finalEntityView?.entities || []).filter(isSignificantEntity);
    const inferredNodeIds = new Set<string>();
    const entities: CanvasEntityDraft[] = [];
    let autoIndex = 0;
    for (const record of significantEntities) {
        if (inferredNodeIds.has(record.nodeId)) {
            continue;
        }
        inferredNodeIds.add(record.nodeId);
        const inferred = buildInferredEntity(snapshot, record, autoIndex);
        autoIndex += 1;
        entities.push(inferred);
    }
    return entities;
};

const resolveSelectedRootNodeId = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    selected: CanvasEntityDraft,
): string | null => {
    if (selected.source === 'node') {
        return countMatches(snapshot, selected.target)[0] ?? null;
    }
    const wantedName = normalizeText(selected.target.nameContains);
    const record = (finalEntityView?.entities || []).find((entity) => {
        if (entity.type !== selected.source || entity.kind !== selected.kind) {return false;}
        if (!wantedName) {return true;}
        return (normalizeText(entity.name) || '').includes(wantedName);
    });
    return record?.nodeId ?? null;
};

const mergeScopedAnnotations = (
    selected: CanvasEntityDraft['annotations'],
    inferred: CanvasEntityDraft['annotations'],
): CanvasEntityDraft['annotations'] => {
    const out = selected.map((item) => ({...item, target: {...item.target}}));
    const byKey = new Map(out.map((item, index) => [item.businessKey, index]));
    for (const item of inferred) {
        const index = byKey.get(item.businessKey);
        if (index === undefined) {
            byKey.set(item.businessKey, out.length);
            out.push({...item, target: {...item.target}});
        } else if (out[index].origin === 'inferred') {
            out[index] = {...out[index], ...item, id: out[index].id, target: {...item.target}};
        }
    }
    return out;
};

const mergeScopedColumns = (
    selected: CanvasEntityDraft['columns'],
    inferred: CanvasEntityDraft['columns'],
): CanvasEntityDraft['columns'] => {
    const out = selected.map((column) => ({
        ...column,
        actions: column.actions.map((action) => ({...action, target: {...action.target}})),
    }));
    const byKey = new Map(out.map((column, index) => [column.fieldKey, index]));
    for (const column of inferred) {
        const index = byKey.get(column.fieldKey);
        const cloned = {
            ...column,
            actions: column.actions.map((action) => ({...action, target: {...action.target}})),
        };
        if (index === undefined) {
            byKey.set(column.fieldKey, out.length);
            out.push(cloned);
        } else if (out[index].origin === 'inferred') {
            out[index] = {...out[index], ...cloned, id: out[index].id};
        }
    }
    return out;
};

const recognizeWithinSelectedEntity = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    existingDraft: CanvasDraft,
): {canvasDraft: CanvasDraft; recognized: RecognizedItem[]} => {
    const selected = existingDraft.entities[0];
    const rootNodeId = resolveSelectedRootNodeId(snapshot, finalEntityView, selected);
    if (!rootNodeId) {
        return {
            canvasDraft: existingDraft,
            recognized: [summarizeEntity(selected, 'existing')],
        };
    }
    const parentById = buildParentById(snapshot.root);
    const records = (finalEntityView?.entities || [])
        .filter(isSignificantEntity)
        .filter((record) => isDescendantOrSelf(record.nodeId, rootNodeId, parentById));
    const inferred = records.map((record, index) => buildInferredEntity(snapshot, record, index));
    const annotations = mergeScopedAnnotations(
        selected.annotations,
        inferred.flatMap((entity) => entity.annotations),
    );
    const columns = mergeScopedColumns(
        selected.columns,
        inferred.flatMap((entity) => entity.columns),
    );
    const primaryKey = selected.primaryKey ?? inferred.find((entity) => entity.primaryKey)?.primaryKey;
    const pagination = selected.pagination ?? inferred.find((entity) => entity.pagination)?.pagination;
    const entity: CanvasEntityDraft = {
        ...selected,
        target: {...selected.target},
        annotations,
        columns,
        ...(primaryKey ? {primaryKey} : {}),
        ...(pagination ? {pagination: {...pagination, pageTarget: {...pagination.pageTarget}}} : {}),
    };
    const canvasDraft: CanvasDraft = {
        ...existingDraft,
        entities: [entity],
    };
    return {
        canvasDraft,
        recognized: [summarizeEntity(entity, 'existing')],
    };
};

const buildPageFallbackEntity = (
    snapshot: SnapshotResult,
    pageKind: EntityKind,
): CanvasEntityDraft => {
    const rootRole = normalizeText(snapshot.root.role) || 'root';
    const pageName = normalizeText(snapshot.root.name) || `页面${pageKind === 'form' ? '表单' : '实体'}`;
    return {
        id: entityCanvasId(0),
        source: 'node',
        kind: pageKind,
        name: pageName,
        businessTag: `${pageKind}.page`,
        target: {roleEquals: rootRole},
        expect: 'unique',
        annotations: [],
        columns: [],
        origin: 'inferred',
    };
};

export const recognizeEntities = (
    snapshot: SnapshotResult,
    finalEntityView: FinalEntityView | undefined,
    existingDraft?: CanvasDraft,
): { canvasDraft: CanvasDraft; recognized: RecognizedItem[] } => {
    if (existingDraft?.entities.length === 1 && existingDraft.entities[0].origin === 'manual') {
        return recognizeWithinSelectedEntity(snapshot, finalEntityView, existingDraft);
    }
    const pageKind = existingDraft?.page.kind || inferPageKind(finalEntityView);
    const page: CanvasPageDraft = existingDraft?.page || { kind: pageKind };

    const inferredEntities = buildFreshInferredEntities(snapshot, finalEntityView);
    const hasPageKindEntity = inferredEntities.some((entity) => entity.kind === pageKind);
    const freshEntities = hasPageKindEntity
        ? inferredEntities
        : [
              buildPageFallbackEntity(snapshot, pageKind),
              ...inferredEntities.map((entity, index) => ({...entity, id: entityCanvasId(index + 1)})),
          ];
    const { draft: canvasDraft } = protectiveMerge(existingDraft, freshEntities, page);

    const existingTags = new Set(
        (existingDraft?.entities || []).map((entity) => entity.businessTag),
    );
    const recognized: RecognizedItem[] = canvasDraft.entities.map((entity) =>
        summarizeEntity(
            entity,
            existingTags.has(entity.businessTag) ? 'existing' : 'inferred',
        ),
    );

    return { canvasDraft, recognized };
};
