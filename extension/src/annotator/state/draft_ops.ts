import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
} from '../types.js';

const cloneDraft = (draft: CanvasDraft): CanvasDraft => ({
    ...draft,
    page: {...draft.page},
    entities: draft.entities.map((entity) => ({
        ...entity,
        target: {...entity.target},
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
    entity.columns[index] = {...entity.columns[index], ...patch, origin: 'confirmed'};
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
