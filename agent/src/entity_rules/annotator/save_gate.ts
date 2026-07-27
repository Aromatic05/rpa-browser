import { detectPreservedConflicts } from './preserved';
import { paginationItemCanvasId, paginationPageCanvasId } from './identifiers';
import type { AnnotationOrigin, CanvasDraft, CompileResult } from './types';
import type { CheckResultByAnnotation } from './runtime_types';
import type { EntityRuleExpect } from '../../runner/steps/executors/snapshot/entity_rules/types';

export type SaveGateBlockCode =
    | 'schema_invalid'
    | 'reference_missing'
    | 'page_stale'
    | 'primary_entity_unresolved'
    | 'confirmed_unique_zero'
    | 'confirmed_unique_multiple'
    | 'opaque_unmergeable'
    | 'revision_conflict';

export type SaveGateResult =
    | { ok: true }
    | { ok: false; code: SaveGateBlockCode; message: string };

const ENTITY_PREFIX = 'entity:';

const isProtectedOrigin = (origin: AnnotationOrigin): boolean =>
    origin === 'confirmed' || origin === 'manual';

type ItemMeta = {
    origin: AnnotationOrigin;
    expect: EntityRuleExpect;
    isEntity: boolean;
};

const collectItemMeta = (draft: CanvasDraft): Map<string, ItemMeta> => {
    const map = new Map<string, ItemMeta>();
    for (const entity of draft.entities) {
        map.set(`${ENTITY_PREFIX}${entity.id}`, {
            origin: entity.origin,
            expect: entity.expect ?? 'unique',
            isEntity: true,
        });
        for (const annotation of entity.annotations) {
            map.set(annotation.id, {
                origin: annotation.origin,
                expect: annotation.expect ?? (annotation.type === 'action' ? 'one_or_more' : 'unique'),
                isEntity: false,
            });
        }
        for (const column of entity.columns) {
            for (const action of column.actions) {
                map.set(action.id, {
                    origin: action.origin,
                    expect: 'one_or_more',
                    isEntity: false,
                });
            }
        }
        if (entity.pagination) {
            map.set(paginationItemCanvasId(entity.id), {
                origin: 'inferred',
                expect: 'unique',
                isEntity: false,
            });
            map.set(paginationPageCanvasId(entity.id), {
                origin: 'inferred',
                expect: 'unique',
                isEntity: false,
            });
        }
    }
    return map;
};

export const detectOpaqueMergeConflicts = (draft: CanvasDraft): string[] => {
    const conflicts: string[] = [...detectPreservedConflicts(draft)];
    const canvasIds = new Set<string>();
    for (const entity of draft.entities) {
        canvasIds.add(entity.id);
        for (const annotation of entity.annotations) {
            canvasIds.add(annotation.id);
        }
        for (const column of entity.columns) {
            canvasIds.add(column.id);
            for (const action of column.actions) {
                canvasIds.add(action.id);
            }
        }
    }
    const preserved = draft.preserved;
    if (preserved && Array.isArray(preserved.ruleRefs)) {
        for (const ref of preserved.ruleRefs) {
            if (!canvasIds.has(ref.canvasAnnotationId)) {
                conflicts.push(
                    `preserved ref owner ${ref.canvasAnnotationId} no longer exists on canvas`,
                );
            }
        }
    }
    return conflicts;
};

export const evaluateSaveGate = (
    draft: CanvasDraft,
    checkResults: CheckResultByAnnotation[],
    stale: boolean,
    revisionConflict: boolean,
    compileResult: CompileResult,
): SaveGateResult => {
    if (!compileResult.ok) {
        const opaque = detectOpaqueMergeConflicts(draft);
        if (opaque.length > 0) {
            return {
                ok: false,
                code: 'opaque_unmergeable',
                message: opaque.join('; '),
            };
        }
        return {
            ok: false,
            code: 'schema_invalid',
            message: compileResult.errors.join('; '),
        };
    }

    if (revisionConflict) {
        return {
            ok: false,
            code: 'revision_conflict',
            message: 'artifact revision conflict: stored artifact changed since open',
        };
    }

    if (stale) {
        return {
            ok: false,
            code: 'page_stale',
            message: 'page identity changed since open; re-check before save',
        };
    }

    const meta = collectItemMeta(draft);
    for (const result of checkResults) {
        const info = meta.get(result.canvasAnnotationId);
        if (!info) {
            continue;
        }

        if (info.isEntity) {
            if (result.matchCount === 0) {
                return {
                    ok: false,
                    code: 'primary_entity_unresolved',
                    message: `primary entity ${result.canvasAnnotationId} resolved 0 matches`,
                };
            }
            continue;
        }

        if (!isProtectedOrigin(info.origin)) {
            continue;
        }

        if (result.matchCount === 0) {
            if (info.expect === 'unique') {
                return {
                    ok: false,
                    code: 'confirmed_unique_zero',
                    message: `confirmed annotation ${result.canvasAnnotationId} expected unique but matched 0`,
                };
            }
            return {
                ok: false,
                code: 'reference_missing',
                message: `confirmed annotation ${result.canvasAnnotationId} references a missing target`,
            };
        }

        if (info.expect === 'unique' && result.matchCount > 1) {
            return {
                ok: false,
                code: 'confirmed_unique_multiple',
                message: `confirmed annotation ${result.canvasAnnotationId} expected unique but matched ${result.matchCount}`,
            };
        }
    }

    return { ok: true };
};
