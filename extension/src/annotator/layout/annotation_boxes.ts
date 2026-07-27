import type {
    CanvasAnnotationDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CheckResultByAnnotation,
    VisualTargetRef,
    PickRect,
} from '../types.js';
import type {LabelTarget} from '../layout/label_layout.js';
import type {Point, Rect} from './box_geometry.js';

export type AnnotationBoxKind =
    | 'entity'
    | 'field'
    | 'action'
    | 'column'
    | 'pagination';

export type AnnotationBox = {
    annotationId: string;
    entityId: string;
    kind: AnnotationBoxKind;
    boxes: PickRect[];
    origin: CanvasAnnotationDraft['origin'];
    disposition: CanvasAnnotationDraft['disposition'];
    expect?: CanvasAnnotationDraft['expect'];
    matchCount: number;
    labelName: string;
    businessKey: string;
};

const roleToKind = (role: VisualTargetRef['role']): AnnotationBoxKind => {
    switch (role) {
        case 'entity': return 'entity';
        case 'field': return 'field';
        case 'action': return 'action';
        case 'column': return 'column';
        case 'pagination': return 'pagination';
    }
};

const boxesFromTarget = (target: VisualTargetRef): PickRect[] => {
    if (target.matchedNodeBoxes && target.matchedNodeBoxes.length > 0) {
        return target.matchedNodeBoxes;
    }
    if (target.bbox) {
        return [target.bbox];
    }
    return [];
};

const checkLookup = (
    results: CheckResultByAnnotation[] | null,
    annotationId: string,
): CheckResultByAnnotation | null => {
    if (!results) {return null;}
    for (const result of results) {
        if (result.canvasAnnotationId === annotationId) {return result;}
    }
    return null;
};

const annotationLabelName = (annotation: CanvasAnnotationDraft): string =>
    annotation.name?.trim() || annotation.businessKey;

const entityLabelName = (entity: CanvasEntityDraft): string =>
    entity.name?.trim() || entity.businessTag;

const kindFromAnnotationType = (
    type: CanvasAnnotationDraft['type'],
): AnnotationBoxKind => {
    switch (type) {
        case 'field': return 'field';
        case 'action': return 'action';
        case 'pagination': return 'pagination';
    }
};

const collectEntityBox = (
    entity: CanvasEntityDraft,
    bindings: VisualTargetRef[],
): AnnotationBox | null => {
    const entityBinding = bindings.find(
        (binding) => binding.entityId === entity.id && binding.role === 'entity',
    );
    const boxes = entityBinding ? boxesFromTarget(entityBinding) : [];
    if (boxes.length === 0) {return null;}
    return {
        annotationId: `entity:${entity.id}`,
        entityId: entity.id,
        kind: 'entity',
        boxes,
        origin: entity.origin,
        disposition: 'active',
        expect: entity.expect,
        matchCount: boxes.length,
        labelName: entityLabelName(entity),
        businessKey: entity.businessTag,
    };
};

const collectAnnotationBox = (
    entity: CanvasEntityDraft,
    annotation: CanvasAnnotationDraft,
    bindings: VisualTargetRef[],
    results: CheckResultByAnnotation[] | null,
): AnnotationBox => {
    let source: VisualTargetRef | undefined;
    for (const binding of bindings) {
        if (binding.entityId !== entity.id || binding.role === 'entity') {continue;}
        if (binding.canvasAnnotationId === annotation.id) {
            source = binding;
            break;
        }
    }
    if (!source) {
        source = bindings.find(
            (binding) =>
                binding.entityId === entity.id &&
                binding.role !== 'entity' &&
                (binding.fieldKey === annotation.businessKey ||
                    binding.actionIntent === annotation.businessKey),
        );
    }
    const boxes = source ? boxesFromTarget(source) : [];
    const check = checkLookup(results, annotation.id);
    return {
        annotationId: annotation.id,
        entityId: entity.id,
        kind: kindFromAnnotationType(annotation.type),
        boxes,
        origin: annotation.origin,
        disposition: annotation.disposition,
        expect: annotation.expect,
        matchCount: check?.matchCount ?? boxes.length,
        labelName: annotationLabelName(annotation),
        businessKey: annotation.businessKey,
    };
};

export const deriveAnnotationBoxes = (
    draft: CanvasDraft | null,
    bindings: VisualTargetRef[],
    currentEntityId: string | null,
    results: CheckResultByAnnotation[] | null,
): AnnotationBox[] => {
    if (!draft) {return [];}
    const entities = currentEntityId
        ? draft.entities.filter((entity) => entity.id === currentEntityId)
        : draft.entities;
    const out: AnnotationBox[] = [];
    for (const entity of entities) {
        const entityBox = collectEntityBox(entity, bindings);
        if (entityBox) {out.push(entityBox);}
        for (const annotation of entity.annotations) {
            out.push(collectAnnotationBox(entity, annotation, bindings, results));
        }
    }
    return out;
};

export const boxCenter = (box: PickRect): Point => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
});

export const boxToRect = (box: PickRect): Rect => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
});

export const annotationLabelTarget = (
    annotationBox: AnnotationBox,
): LabelTarget | null => {
    if (annotationBox.boxes.length === 0) {return null;}
    const center = annotationBox.boxes.reduce(
        (acc, box) => ({
            x: acc.x + boxCenter(box).x,
            y: acc.y + boxCenter(box).y,
        }),
        {x: 0, y: 0},
    );
    center.x /= annotationBox.boxes.length;
    center.y /= annotationBox.boxes.length;
    const firstBox = annotationBox.boxes[0];
    return {
        annotationId: annotationBox.annotationId,
        targetCenter: center,
        targetBox: firstBox,
    };
};

export {roleToKind};
