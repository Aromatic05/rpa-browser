import type {
    EntityAnnotationRule,
    EntityAnnotationSet,
    EntityMatchRule,
    EntityRuleSet,
} from '../../runner/steps/executors/snapshot/entity_rules/types';
import type {
    CanvasDraft,
    PreservedArtifactData,
    PreservedLocatorRule,
    PreservedRuleRef,
    PreservedSubPath,
} from './types';
import { annotationCanvasId } from './identifiers';

const getPathValue = (root: unknown, path: Array<string | number>): unknown => {
    let current: unknown = root;
    for (const segment of path) {
        if (current === null || current === undefined) {return undefined;}
        if (typeof segment === 'number') {
            if (!Array.isArray(current)) {return undefined;}
            current = current[segment];
        } else {
            if (typeof current !== 'object') {return undefined;}
            current = (current as Record<string, unknown>)[segment];
        }
    }
    return current;
};

const setPathValue = (root: unknown, path: Array<string | number>, value: unknown): void => {
    if (typeof root !== 'object' || root === null) {return;}
    let current: unknown = root;
    for (let i = 0; i < path.length - 1; i++) {
        const segment = path[i];
        if (typeof segment === 'number') {
            if (!Array.isArray(current)) {return;}
            if (current[segment] === undefined || current[segment] === null) {
                current[segment] = typeof path[i + 1] === 'number' ? [] : {};
            }
            current = current[segment];
        } else {
            if (typeof current !== 'object' || current === null) {return;}
            const record = current as Record<string, unknown>;
            if (record[segment] === undefined || record[segment] === null) {
                record[segment] = typeof path[i + 1] === 'number' ? [] : {};
            }
            current = record[segment];
        }
    }
    const last = path[path.length - 1];
    if (typeof last === 'number') {
        if (!Array.isArray(current)) {return;}
        current[last] = value;
    } else {
        if (typeof current !== 'object' || current === null) {return;}
        (current as Record<string, unknown>)[last] = value;
    }
};

type CapturedPath = {
    subPath: Array<string | number>;
    value: unknown;
    kind: 'value';
};

const captureFromAnnotationRule = (annotationRule: EntityAnnotationRule): CapturedPath[] => {
    const captured: CapturedPath[] = [];

    if (annotationRule.fields) {
        for (let i = 0; i < annotationRule.fields.length; i++) {
            const field = annotationRule.fields[i];
            if (field.kind) {
                captured.push({ subPath: ['fields', i, 'kind'], value: field.kind, kind: 'value' });
            }
            if (field.optionSource) {
                captured.push({
                    subPath: ['fields', i, 'optionSource', 'kind'],
                    value: field.optionSource.kind,
                    kind: 'value',
                });
            }
        }
    }

    return captured;
};

export const capturePreservedByCanvasId = (
    annotationSet: EntityAnnotationSet,
    ruleIdToCanvasId: Record<string, string>,
): Record<string, PreservedSubPath[]> => {
    const byCanvasId: Record<string, PreservedSubPath[]> = {};
    for (const annotationRule of annotationSet.annotations) {
        const canvasId = ruleIdToCanvasId[annotationRule.ruleId];
        if (!canvasId) {continue;}
        const captured = captureFromAnnotationRule(annotationRule);
        if (captured.length > 0) {
            byCanvasId[canvasId] = captured.map(({ subPath, kind }) => ({ subPath, kind }));
        }
    }
    return byCanvasId;
};

const annotationHasBusinessSemantics = (annotation: EntityAnnotationRule): boolean =>
    Boolean(
        annotation.businessTag ||
            annotation.businessName ||
            annotation.primaryKey ||
            annotation.columns ||
            annotation.fields ||
            annotation.actions ||
            annotation.pagination ||
            annotation.fieldKey ||
            annotation.actionIntent,
    );

type FieldRefTarget = {
    ownerRuleId: string;
    fieldIndex: number;
    refKey: 'controlRuleId' | 'labelRuleId';
    targetRuleId: string;
};

type OptionRefTarget = {
    ownerRuleId: string;
    fieldIndex: number;
    targetRuleId: string;
};

type DisabledRefTarget = {
    ownerRuleId: string;
    targetRuleId: string;
};

export const captureLocatorRulesAndRefs = (
    matchSet: EntityRuleSet,
    annotationSet: EntityAnnotationSet,
    ruleIdToCanvasId: Record<string, string>,
): { locatorRules: PreservedLocatorRule[]; ruleRefs: PreservedRuleRef[] } => {
    const matchByRuleId = new Map<string, EntityMatchRule>();
    for (const rule of matchSet.entities) {
        matchByRuleId.set(rule.ruleId, rule);
    }
    const annotationByRuleId = new Map<string, EntityAnnotationRule>();
    for (const ann of annotationSet.annotations) {
        annotationByRuleId.set(ann.ruleId, ann);
    }

    const fieldRefs: FieldRefTarget[] = [];
    const optionRefs: OptionRefTarget[] = [];
    const disabledRefs: DisabledRefTarget[] = [];
    const locatorTargetRuleIds = new Set<string>();

    for (const ann of annotationSet.annotations) {
        if (!ruleIdToCanvasId[ann.ruleId]) {continue;}
        if (ann.fields) {
            for (let i = 0; i < ann.fields.length; i++) {
                const field = ann.fields[i];
                if (field.controlRuleId) {
                    fieldRefs.push({ ownerRuleId: ann.ruleId, fieldIndex: i, refKey: 'controlRuleId', targetRuleId: field.controlRuleId });
                    locatorTargetRuleIds.add(field.controlRuleId);
                }
                if (field.labelRuleId) {
                    fieldRefs.push({ ownerRuleId: ann.ruleId, fieldIndex: i, refKey: 'labelRuleId', targetRuleId: field.labelRuleId });
                    locatorTargetRuleIds.add(field.labelRuleId);
                }
                if (field.optionSource?.optionRuleId) {
                    optionRefs.push({ ownerRuleId: ann.ruleId, fieldIndex: i, targetRuleId: field.optionSource.optionRuleId });
                    locatorTargetRuleIds.add(field.optionSource.optionRuleId);
                }
            }
        }
        if (ann.pagination?.nextAction?.disabledRuleId) {
            disabledRefs.push({ ownerRuleId: ann.ruleId, targetRuleId: ann.pagination.nextAction.disabledRuleId });
            locatorTargetRuleIds.add(ann.pagination.nextAction.disabledRuleId);
        }
    }

    const locatorRules: PreservedLocatorRule[] = [];
    const preservedKeyByOriginalRuleId = new Map<string, string>();
    for (const targetRuleId of locatorTargetRuleIds) {
        if (ruleIdToCanvasId[targetRuleId]) {continue;}
        const matchRule = matchByRuleId.get(targetRuleId);
        if (!matchRule) {continue;}
        const targetAnnotation = annotationByRuleId.get(targetRuleId);
        if (targetAnnotation && annotationHasBusinessSemantics(targetAnnotation)) {continue;}
        const preservedKey = `loc_${targetRuleId}`;
        preservedKeyByOriginalRuleId.set(targetRuleId, preservedKey);
        locatorRules.push({
            preservedKey,
            originalRuleId: targetRuleId,
            source: matchRule.source,
            expect: matchRule.expect,
            ...(matchRule.within ? { within: matchRule.within } : {}),
            match: { ...matchRule.match },
        });
    }

    const ruleRefs: PreservedRuleRef[] = [];
    const pushFieldRef = (ref: FieldRefTarget | OptionRefTarget, refPath: string[]): void => {
        const preservedKey = preservedKeyByOriginalRuleId.get(ref.targetRuleId);
        if (!preservedKey) {return;}
        const entityId = ruleIdToCanvasId[ref.ownerRuleId];
        ruleRefs.push({
            canvasAnnotationId: annotationCanvasId(entityId, 'field', ref.fieldIndex),
            refPath,
            preservedKey,
        });
    };
    for (const ref of fieldRefs) {
        pushFieldRef(ref, [ref.refKey]);
    }
    for (const ref of optionRefs) {
        pushFieldRef(ref, ['optionSource', 'optionRuleId']);
    }
    for (const ref of disabledRefs) {
        const preservedKey = preservedKeyByOriginalRuleId.get(ref.targetRuleId);
        if (!preservedKey) {continue;}
        ruleRefs.push({
            canvasAnnotationId: ruleIdToCanvasId[ref.ownerRuleId],
            refPath: ['pagination', 'nextAction', 'disabledRuleId'],
            preservedKey,
        });
    }

    return { locatorRules, ruleRefs };
};

export const detectPreservedConflicts = (draft: CanvasDraft): string[] => {
    const conflicts: string[] = [];
    for (const entity of draft.entities) {
        const preservedEntity = draft.preserved.preservedByCanvasId[entity.id];
        if (!preservedEntity) {continue;}
        for (const entry of preservedEntity) {
            const pathStr = entry.subPath.join('.');
            if (pathStr.startsWith('fields.') && pathStr.endsWith('.kind')) {continue;}
            if (pathStr.startsWith('fields.') && pathStr.includes('.optionSource.')) {continue;}
            conflicts.push(`${entity.id}.${pathStr}: preserved value path not represented in canvas-driven compile`);
        }
    }
    return conflicts;
};

export const mergePreserved = (
    annotationSet: EntityAnnotationSet,
    canvasIdToRuleId: Record<string, string>,
    preserved: PreservedArtifactData,
): { annotation: EntityAnnotationSet; conflicts: string[] } => {
    const conflicts: string[] = [];
    const annotationByRuleId = new Map<string, EntityAnnotationRule>();
    for (const rule of annotationSet.annotations) {
        annotationByRuleId.set(rule.ruleId, rule);
    }

    const originalAnnotations = (preserved.annotationRaw as EntityAnnotationSet | undefined)?.annotations || [];
    const originalAnnotationByRuleId = new Map<string, EntityAnnotationRule>();
    for (const rule of originalAnnotations) {
        originalAnnotationByRuleId.set(rule.ruleId, rule);
    }

    for (const [canvasId, subPaths] of Object.entries(preserved.preservedByCanvasId)) {
        const newRuleId = canvasIdToRuleId[canvasId];
        if (!newRuleId) {
            conflicts.push(`${canvasId}: canvas id no longer compiles`);
            continue;
        }
        const targetAnnotation = annotationByRuleId.get(newRuleId);
        if (!targetAnnotation) {
            conflicts.push(`${canvasId}: target annotation ${newRuleId} missing`);
            continue;
        }

        const originalRuleId = Object.entries(preserved.ruleIdToCanvasId).find(([, id]) => id === canvasId)?.[0];
        if (!originalRuleId) {continue;}
        const originalAnnotation = originalAnnotationByRuleId.get(originalRuleId);
        if (!originalAnnotation) {continue;}

        for (const entry of subPaths) {
            const originalValue = getPathValue(originalAnnotation, entry.subPath);
            if (originalValue === undefined) {continue;}
            setPathValue(targetAnnotation, entry.subPath, originalValue);
        }
    }

    return { annotation: annotationSet, conflicts };
};

export type RuleIdRewriter = (originalRuleId: string) => string | undefined;

export const emitPreservedLocatorRules = (
    preserved: PreservedArtifactData,
    rewriteRuleId: RuleIdRewriter,
): { rules: EntityMatchRule[]; ruleIdByPreservedKey: Record<string, string>; conflicts: string[] } => {
    const rules: EntityMatchRule[] = [];
    const ruleIdByPreservedKey: Record<string, string> = {};
    const conflicts: string[] = [];

    for (const locator of preserved.locatorRules) {
        let rewrittenWithin: string | undefined;
        if (locator.within) {
            rewrittenWithin = rewriteRuleId(locator.within);
            if (!rewrittenWithin) {
                conflicts.push(`locator ${locator.originalRuleId}: within ${locator.within} cannot be rewritten`);
                continue;
            }
        }
        const rule: EntityMatchRule = {
            ruleId: locator.preservedKey,
            source: locator.source,
            expect: locator.expect,
            match: { ...locator.match },
        };
        if (rewrittenWithin) {
            rule.within = rewrittenWithin;
        }
        rules.push(rule);
        ruleIdByPreservedKey[locator.preservedKey] = locator.preservedKey;
    }

    return { rules, ruleIdByPreservedKey, conflicts };
};

export const applyPreservedRuleRefs = (
    refTargetByCanvasId: Record<string, Record<string, unknown>>,
    ruleIdByPreservedKey: Record<string, string>,
    preserved: PreservedArtifactData,
): string[] => {
    const conflicts: string[] = [];
    for (const ref of preserved.ruleRefs) {
        const target = refTargetByCanvasId[ref.canvasAnnotationId];
        if (!target) {
            conflicts.push(`${ref.canvasAnnotationId}: ref owner not found in compiled annotation`);
            continue;
        }
        const locatorRuleId = ruleIdByPreservedKey[ref.preservedKey];
        if (!locatorRuleId) {
            conflicts.push(`ruleId ref ${ref.preservedKey} cannot be rewritten`);
            continue;
        }
        setPathValue(target, ref.refPath, locatorRuleId);
    }
    return conflicts;
};
