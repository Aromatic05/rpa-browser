import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    PickCandidate,
} from '../types.js';
import {entityVisualId, paginationPageVisualId} from '../visual_ids.js';

export const createEntityScopeDraft = (candidate: PickCandidate): CanvasDraft => {
    const entityRef = candidate.entityRef;
    if (!entityRef || (candidate.level !== 'region' && candidate.level !== 'group')) {
        throw new Error('entity scope candidate is required');
    }
    const target = candidate.proposedTargets?.[0];
    if (!target || Object.keys(target).length === 0) {
        throw new Error('entity scope candidate has no persistent target');
    }
    const name = candidate.text?.trim() || '已选实体区域';
    return {
        version: 1,
        profileName: '',
        page: {kind: entityRef.kind},
        entities: [{
            id: 'e0',
            source: entityRef.type,
            kind: entityRef.kind,
            name,
            businessTag: `${entityRef.kind}.main`,
            entityKey: `${entityRef.kind}Main`,
            target: {...target},
            expect: 'unique',
            annotations: [],
            columns: [],
            origin: 'manual',
        }],
        preserved: {
            matchRaw: {version: 1, page: {kind: entityRef.kind}, entities: []},
            annotationRaw: {version: 1, page: {kind: entityRef.kind}, annotations: []},
            preservedByCanvasId: {},
            ruleIdToCanvasId: {},
            locatorRules: [],
            ruleRefs: [],
        },
    };
};

const cloneDraft = (draft: CanvasDraft): CanvasDraft => ({
    ...draft,
    page: {...draft.page},
    entities: draft.entities.map((entity) => ({
        ...entity,
        target: {...entity.target},
        ...(entity.primaryKey ? {
            primaryKey: {
                fieldKey: entity.primaryKey.fieldKey,
                ...(entity.primaryKey.columns ? {columns: [...entity.primaryKey.columns]} : {}),
            },
        } : {}),
        annotations: entity.annotations.map((annotation) => ({
            ...annotation,
            target: {...annotation.target},
        })),
        columns: entity.columns.map((column) => ({
            ...column,
            actions: column.actions.map((action) => ({...action, target: {...action.target}})),
        })),
    })),
});

const findEntityIndex = (draft: CanvasDraft, entityId: string): number => {
    for (let index = 0; index < draft.entities.length; index += 1) {
        if (draft.entities[index].id === entityId) {return index;}
    }
    return -1;
};

const findAnnotation = (
    entity: CanvasEntityDraft,
    annotationId: string,
): {annotation: CanvasAnnotationDraft; index: number} | null => {
    for (let index = 0; index < entity.annotations.length; index += 1) {
        if (entity.annotations[index].id === annotationId) {
            return {annotation: entity.annotations[index], index};
        }
    }
    return null;
};

export const updateAnnotation = (
    draft: CanvasDraft,
    entityId: string,
    annotationId: string,
    patch: Partial<CanvasAnnotationDraft>,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entityIndex = findEntityIndex(next, entityId);
    if (entityIndex === -1) {return next;}
    const entity = next.entities[entityIndex];
    const found = findAnnotation(entity, annotationId);
    if (!found) {return next;}
    entity.annotations[found.index] = {
        ...found.annotation,
        ...patch,
        target: patch.target ? {...patch.target} : found.annotation.target,
        origin: found.annotation.origin === 'manual' ? 'manual' : 'confirmed',
    };
    return next;
};

export const deleteAnnotation = (
    draft: CanvasDraft,
    entityId: string,
    annotationId: string,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entityIndex = findEntityIndex(next, entityId);
    if (entityIndex === -1) {return next;}
    const entity = next.entities[entityIndex];
    entity.annotations = entity.annotations.filter((annotation) => annotation.id !== annotationId);
    return next;
};

export const setAnnotationDisposition = (
    draft: CanvasDraft,
    entityId: string,
    annotationId: string,
    disposition: CanvasAnnotationDraft['disposition'],
): CanvasDraft => updateAnnotation(draft, entityId, annotationId, {disposition});

export const addAnnotation = (
    draft: CanvasDraft,
    entityId: string,
    annotation: CanvasAnnotationDraft,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entityIndex = findEntityIndex(next, entityId);
    if (entityIndex === -1) {return next;}
    next.entities[entityIndex].annotations.push(annotation);
    return next;
};

export const replaceAnnotationTarget = (
    draft: CanvasDraft,
    entityId: string,
    annotationId: string,
    target: CanvasAnnotationDraft['target'],
): CanvasDraft => updateAnnotation(draft, entityId, annotationId, {target: {...target}});

export const updateEntity = (
    draft: CanvasDraft,
    entityId: string,
    patch: Partial<CanvasEntityDraft>,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const index = findEntityIndex(next, entityId);
    if (index === -1) {return next;}
    const entity = next.entities[index];
    next.entities[index] = {...entity, ...patch, target: patch.target ? {...patch.target} : entity.target, origin: 'confirmed'};
    return next;
};

export const updateColumn = (
    draft: CanvasDraft,
    entityId: string,
    columnId: string,
    patch: Partial<CanvasEntityDraft['columns'][number]>,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entity = next.entities[findEntityIndex(next, entityId)];
    if (!entity) {return next;}
    const index = entity.columns.findIndex((column) => column.id === columnId);
    if (index === -1) {return next;}
    const previousFieldKey = entity.columns[index].fieldKey;
    entity.columns[index] = {...entity.columns[index], ...patch, origin: 'confirmed'};
    const nextFieldKey = entity.columns[index].fieldKey;
    if (entity.primaryKey && previousFieldKey !== nextFieldKey) {
        if (entity.primaryKey.fieldKey === previousFieldKey) {
            entity.primaryKey.fieldKey = nextFieldKey;
        }
        if (entity.primaryKey.columns) {
            entity.primaryKey.columns = entity.primaryKey.columns.map((fieldKey) =>
                fieldKey === previousFieldKey ? nextFieldKey : fieldKey,
            );
        }
    }
    return next;
};

export const setColumnPrimaryKey = (
    draft: CanvasDraft,
    entityId: string,
    columnId: string,
    selected: boolean,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entity = next.entities[findEntityIndex(next, entityId)];
    if (!entity || entity.kind !== 'table') {return next;}
    const column = entity.columns.find((item) => item.id === columnId && item.disposition === 'active');
    if (!column) {return next;}
    if (selected) {
        entity.primaryKey = {fieldKey: column.fieldKey};
    } else if (entity.primaryKey?.fieldKey === column.fieldKey) {
        delete entity.primaryKey;
    }
    entity.origin = 'confirmed';
    return next;
};

export const updateColumnAction = (
    draft: CanvasDraft,
    entityId: string,
    actionId: string,
    patch: Partial<CanvasEntityDraft['columns'][number]['actions'][number]>,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entity = next.entities[findEntityIndex(next, entityId)];
    if (!entity) {return next;}
    for (const column of entity.columns) {
        const index = column.actions.findIndex((action) => action.id === actionId);
        if (index !== -1) {
            column.actions[index] = {...column.actions[index], ...patch, target: patch.target ? {...patch.target} : column.actions[index].target, origin: 'confirmed'};
            break;
        }
    }
    return next;
};

export const updatePagination = (
    draft: CanvasDraft,
    entityId: string,
    patch: Partial<NonNullable<CanvasEntityDraft['pagination']>>,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entity = next.entities[findEntityIndex(next, entityId)];
    if (!entity?.pagination) {return next;}
    entity.pagination = {...entity.pagination, ...patch, pageTarget: patch.pageTarget ? {...patch.pageTarget} : entity.pagination.pageTarget};
    entity.origin = 'confirmed';
    return next;
};

export const replaceVisualItemSelection = (
    draft: CanvasDraft,
    entityId: string,
    visualItemId: string,
    selection: {target: CanvasAnnotationDraft['target']},
): CanvasDraft => {
    const entity = draft.entities.find((item) => item.id === entityId);
    if (!entity) {return cloneDraft(draft);}
    if (visualItemId === entityVisualId(entityId)) {
        return updateEntity(draft, entityId, {target: selection.target});
    }
    const column = entity.columns.find((item) => item.id === visualItemId);
    if (column) {
        return cloneDraft(draft);
    }
    if (entity.columns.some((item) => item.actions.some((action) => action.id === visualItemId))) {
        return updateColumnAction(draft, entityId, visualItemId, {
            target: selection.target,
        });
    }
    if (visualItemId === paginationPageVisualId(entityId)) {
        return updatePagination(draft, entityId, {pageTarget: selection.target});
    }
    return replaceAnnotationTarget(draft, entityId, visualItemId, selection.target);
};

export const deleteVisualItem = (
    draft: CanvasDraft,
    entityId: string,
    visualItemId: string,
): CanvasDraft => {
    const next = cloneDraft(draft);
    const entityIndex = findEntityIndex(next, entityId);
    if (entityIndex === -1) {return next;}
    if (visualItemId === entityVisualId(entityId)) {
        next.entities.splice(entityIndex, 1);
        return next;
    }
    const entity = next.entities[entityIndex];
    const columnIndex = entity.columns.findIndex((column) => column.id === visualItemId);
    if (columnIndex !== -1) {
        const removedFieldKey = entity.columns[columnIndex].fieldKey;
        entity.columns.splice(columnIndex, 1);
        if (
            entity.primaryKey?.fieldKey === removedFieldKey ||
            entity.primaryKey?.columns?.includes(removedFieldKey)
        ) {
            delete entity.primaryKey;
        }
        return next;
    }
    for (const column of entity.columns) {
        const actionIndex = column.actions.findIndex((action) => action.id === visualItemId);
        if (actionIndex !== -1) {
            column.actions.splice(actionIndex, 1);
            return next;
        }
    }
    if (visualItemId === paginationPageVisualId(entityId)) {
        delete entity.pagination;
        return next;
    }
    entity.annotations = entity.annotations.filter((annotation) => annotation.id !== visualItemId);
    return next;
};

export const ignoreVisualItem = (
    draft: CanvasDraft,
    entityId: string,
    visualItemId: string,
): CanvasDraft => {
    const entity = draft.entities.find((item) => item.id === entityId);
    if (!entity) {return cloneDraft(draft);}
    const column = entity.columns.find((item) => item.id === visualItemId);
    if (column) {
        return updateColumn(draft, entityId, visualItemId, {disposition: 'ignored'});
    }
    if (entity.columns.some((item) => item.actions.some((action) => action.id === visualItemId))) {
        return updateColumnAction(draft, entityId, visualItemId, {disposition: 'ignored'});
    }
    return setAnnotationDisposition(draft, entityId, visualItemId, 'ignored');
};
