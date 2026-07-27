import type {
    AnnotationOrigin,
    CanvasAnnotationDraft,
    CanvasColumnActionDraft,
    CanvasColumnDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CanvasPageDraft,
    PersistentTargetDraft,
} from './types';
import { entityCanvasId } from './identifiers';

export type MergeStats = {
    newCount: number;
    refreshedCount: number;
    invalidatedCount: number;
};

export type ProtectiveMergeResult = {
    draft: CanvasDraft;
    stats: MergeStats;
};

const cloneTarget = (target: PersistentTargetDraft): PersistentTargetDraft => ({ ...target });

const isProtectedOrigin = (origin: AnnotationOrigin): boolean =>
    origin === 'confirmed' || origin === 'manual';

const cloneAnnotation = (annotation: CanvasAnnotationDraft): CanvasAnnotationDraft => ({
    ...annotation,
    target: cloneTarget(annotation.target),
});

const cloneColumnAction = (action: CanvasColumnActionDraft): CanvasColumnActionDraft => ({
    ...action,
    target: cloneTarget(action.target),
});

const cloneColumn = (column: CanvasColumnDraft): CanvasColumnDraft => ({
    ...column,
    actions: column.actions.map(cloneColumnAction),
});

const cloneEntityShape = (entity: CanvasEntityDraft): CanvasEntityDraft => ({
    ...entity,
    target: cloneTarget(entity.target),
    annotations: entity.annotations.map(cloneAnnotation),
    columns: entity.columns.map(cloneColumn),
});

const allocateEntityId = (used: Set<string>): string => {
    let index = 0;
    while (used.has(entityCanvasId(index))) {
        index += 1;
    }
    const id = entityCanvasId(index);
    used.add(id);
    return id;
};

const mergeColumnActions = (
    existing: CanvasColumnActionDraft[],
    fresh: CanvasColumnActionDraft[],
    stats: MergeStats,
): CanvasColumnActionDraft[] => {
    const out: CanvasColumnActionDraft[] = [];
    const freshByIntent = new Map(fresh.map((action) => [action.actionIntent, action]));
    const existingIntents = new Set<string>();
    for (const ex of existing) {
        existingIntents.add(ex.actionIntent);
        const fr = freshByIntent.get(ex.actionIntent);
        if (isProtectedOrigin(ex.origin)) {
            out.push(cloneColumnAction(ex));
            if (!fr) {
                stats.invalidatedCount += 1;
            }
            continue;
        }
        if (ex.disposition === 'ignored') {
            out.push(cloneColumnAction(ex));
            continue;
        }
        if (fr) {
            out.push({ ...ex, target: cloneTarget(fr.target) });
            stats.refreshedCount += 1;
        } else {
            out.push(cloneColumnAction(ex));
        }
    }
    for (const fr of fresh) {
        if (existingIntents.has(fr.actionIntent)) {
            continue;
        }
        out.push({
            ...fr,
            target: cloneTarget(fr.target),
            origin: 'inferred',
            disposition: 'active',
        });
        stats.newCount += 1;
    }
    return out;
};

const mergeColumns = (
    existing: CanvasColumnDraft[],
    fresh: CanvasColumnDraft[],
    stats: MergeStats,
): CanvasColumnDraft[] => {
    const out: CanvasColumnDraft[] = [];
    const freshByKey = new Map(fresh.map((column) => [column.fieldKey, column]));
    const existingKeys = new Set<string>();
    for (const ex of existing) {
        existingKeys.add(ex.fieldKey);
        const fr = freshByKey.get(ex.fieldKey);
        if (isProtectedOrigin(ex.origin)) {
            out.push(cloneColumn(ex));
            if (!fr) {
                stats.invalidatedCount += 1;
            }
            continue;
        }
        if (ex.disposition === 'ignored') {
            out.push(cloneColumn(ex));
            continue;
        }
        if (fr) {
            out.push({
                ...ex,
                actions: mergeColumnActions(ex.actions, fr.actions, stats),
            });
            stats.refreshedCount += 1;
        } else {
            out.push(cloneColumn(ex));
        }
    }
    for (const fr of fresh) {
        if (existingKeys.has(fr.fieldKey)) {
            continue;
        }
        out.push({
            ...fr,
            actions: fr.actions.map((action) => ({
                ...action,
                target: cloneTarget(action.target),
            })),
            origin: 'inferred',
            disposition: 'active',
        });
        stats.newCount += 1;
    }
    return out;
};

const mergeAnnotations = (
    existing: CanvasAnnotationDraft[],
    fresh: CanvasAnnotationDraft[],
    stats: MergeStats,
): CanvasAnnotationDraft[] => {
    const out: CanvasAnnotationDraft[] = [];
    const freshByKey = new Map(fresh.map((annotation) => [annotation.businessKey, annotation]));
    const existingKeys = new Set<string>();
    for (const ex of existing) {
        existingKeys.add(ex.businessKey);
        const fr = freshByKey.get(ex.businessKey);
        if (isProtectedOrigin(ex.origin)) {
            out.push(cloneAnnotation(ex));
            if (!fr) {
                stats.invalidatedCount += 1;
            }
            continue;
        }
        if (ex.disposition === 'ignored') {
            out.push(cloneAnnotation(ex));
            continue;
        }
        if (fr) {
            out.push({ ...ex, target: cloneTarget(fr.target) });
            stats.refreshedCount += 1;
        } else {
            out.push(cloneAnnotation(ex));
        }
    }
    for (const fr of fresh) {
        if (existingKeys.has(fr.businessKey)) {
            continue;
        }
        out.push({
            ...fr,
            target: cloneTarget(fr.target),
            origin: 'inferred',
            disposition: 'active',
        });
        stats.newCount += 1;
    }
    return out;
};

const mergeEntity = (
    existing: CanvasEntityDraft,
    fresh: CanvasEntityDraft | undefined,
    stats: MergeStats,
): CanvasEntityDraft => {
    if (isProtectedOrigin(existing.origin)) {
        if (!fresh) {
            stats.invalidatedCount += 1 + countProtectedAnnotations(existing);
        }
        return cloneEntityShape(existing);
    }
    if (!fresh) {
        return cloneEntityShape(existing);
    }
    stats.refreshedCount += 1;
    return {
        ...existing,
        target: cloneTarget(fresh.target),
        annotations: mergeAnnotations(existing.annotations, fresh.annotations, stats),
        columns: mergeColumns(existing.columns, fresh.columns, stats),
    };
};

const countProtectedAnnotations = (entity: CanvasEntityDraft): number =>
    entity.annotations.filter((annotation) => isProtectedOrigin(annotation.origin)).length
    + entity.columns.reduce(
        (sum, column) =>
            sum
            + (isProtectedOrigin(column.origin) ? 1 : 0)
            + column.actions.filter((action) => isProtectedOrigin(action.origin)).length,
        0,
    );

const buildPreservedForFresh = (page: CanvasPageDraft): CanvasDraft['preserved'] => ({
    matchRaw: { version: 1, page, entities: [] },
    annotationRaw: { version: 1, page, annotations: [] },
    preservedByCanvasId: {},
    ruleIdToCanvasId: {},
    locatorRules: [],
    ruleRefs: [],
});

export const protectiveMerge = (
    existingDraft: CanvasDraft | null | undefined,
    freshEntities: CanvasEntityDraft[],
    page: CanvasPageDraft,
): ProtectiveMergeResult => {
    const stats: MergeStats = { newCount: 0, refreshedCount: 0, invalidatedCount: 0 };
    const base: CanvasDraft = existingDraft
        ? { ...existingDraft }
        : {
            version: 1,
            profileName: '',
            page,
            entities: [],
            preserved: buildPreservedForFresh(page),
        };

    const usedEntityIds = new Set(base.entities.map((entity) => entity.id));
    const freshByTag = new Map(freshEntities.map((entity) => [entity.businessTag, entity]));
    const existingTags = new Set<string>();

    const mergedEntities: CanvasEntityDraft[] = base.entities.map((existing) => {
        existingTags.add(existing.businessTag);
        return mergeEntity(existing, freshByTag.get(existing.businessTag), stats);
    });

    for (const fr of freshEntities) {
        if (existingTags.has(fr.businessTag)) {
            continue;
        }
        const id = allocateEntityId(usedEntityIds);
        const cloned = cloneEntityShape({ ...fr, id });
        mergedEntities.push(cloned);
        stats.newCount += 1 + fr.annotations.length + fr.columns.length;
    }

    const draft: CanvasDraft = {
        ...base,
        page,
        entities: mergedEntities,
    };
    return { draft, stats };
};
