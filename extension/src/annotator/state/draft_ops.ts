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
