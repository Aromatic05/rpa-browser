import type { WorkflowEntityRules } from '../../workflow/entity_rules';
import type {
    EntityAnnotationRule,
    EntityAnnotationSet,
    EntityMatchRule,
    EntityRuleMatch,
    EntityRuleSet,
} from '../../runner/steps/executors/snapshot/entity_rules/types';
import { validateEntityRules } from '../../runner/steps/executors/snapshot/entity_rules/validate';
import type {
    CanvasAnnotationDraft,
    CanvasColumnActionDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CompileResult,
    EntityRuleExpect,
    PersistentTargetDraft,
} from './types';
import { validateCanvasDraft, hasTargetConditions } from './validate';
import {
    columnActionRuleId,
    entityRuleId,
    paginationItemCanvasId,
    paginationItemRuleId,
    paginationPageCanvasId,
    paginationPageRuleId,
} from './identifiers';
import { applyPreservedRuleRefs, emitPreservedLocatorRules, mergePreserved } from './preserved';

const fromPersistentTarget = (target: PersistentTargetDraft): EntityRuleMatch => {
    const match: EntityRuleMatch = {};
    if (target.kind) {match.kind = target.kind;}
    if (target.nameContains) {match.nameContains = target.nameContains;}
    if (target.idEquals) {match.idEquals = target.idEquals;}
    if (target.nameEquals) {match.nameEquals = target.nameEquals;}
    if (target.roleEquals) {match.roleEquals = target.roleEquals;}
    if (target.classContains) {match.classContains = target.classContains;}
    if (target.textContains) {match.textContains = target.textContains;}
    if (target.ariaContains) {match.ariaContains = target.ariaContains;}
    if (target.keyHint) {match.keyHint = target.keyHint;}
    if (target.relation) {match.relation = target.relation;}
    return match;
};

const hasColumnActionTarget = (action: CanvasColumnActionDraft): boolean => hasTargetConditions(action.target);

const defaultAnnotationExpect = (annotation: CanvasAnnotationDraft): EntityRuleExpect =>
    annotation.type === 'action' ? 'one_or_more' : 'unique';

const compileEntity = (
    entity: CanvasEntityDraft,
    entityIdx: number,
    matchEntities: EntityMatchRule[],
    ruleIdByEntityId: Record<string, string>,
    ruleIdByAnnotationId: Record<string, string>,
    refTargetByCanvasId: Record<string, Record<string, unknown>>,
): EntityAnnotationRule => {
    const rootRuleId = entityRuleId(entityIdx);
    ruleIdByEntityId[entity.id] = rootRuleId;

    matchEntities.push({
        ruleId: rootRuleId,
        source: entity.source,
        expect: entity.expect ?? 'unique',
        match: fromPersistentTarget(entity.target),
    });

    let annotationChildCounter = 0;
    const annotationRuleIdByCanvasId = new Map<string, string>();

    for (const annotation of entity.annotations) {
        if (!hasTargetConditions(annotation.target)) {continue;}
        const annRuleId = `${rootRuleId}_ann${annotationChildCounter++}`;
        annotationRuleIdByCanvasId.set(annotation.id, annRuleId);
        ruleIdByAnnotationId[annotation.id] = annRuleId;
        matchEntities.push({
            ruleId: annRuleId,
            source: 'node',
            expect: annotation.expect ?? defaultAnnotationExpect(annotation),
            within: rootRuleId,
            match: fromPersistentTarget(annotation.target),
        });
    }

    let columnActionCounter = 0;
    for (const column of entity.columns) {
        for (const action of column.actions) {
            if (!hasColumnActionTarget(action)) {continue;}
            const colActRuleId = columnActionRuleId(rootRuleId, columnActionCounter++);
            ruleIdByAnnotationId[action.id] = colActRuleId;
            matchEntities.push({
                ruleId: colActRuleId,
                source: 'node',
                expect: 'one_or_more',
                within: rootRuleId,
                match: fromPersistentTarget(action.target),
            });
        }
    }

    let paginationPageRule: string | undefined;
    if (entity.pagination) {
        const itemRuleId = paginationItemRuleId(rootRuleId);
        const itemMatch: EntityRuleMatch = { relation: 'pagination' };
        if (entity.pagination.itemTarget) {
            const itemTargetMatch = fromPersistentTarget(entity.pagination.itemTarget);
            for (const [key, value] of Object.entries(itemTargetMatch)) {
                if (key === 'relation') {continue;}
                (itemMatch as Record<string, unknown>)[key] = value;
            }
        }
        matchEntities.push({
            ruleId: itemRuleId,
            source: 'node',
            expect: 'unique',
            match: itemMatch,
        });
        ruleIdByAnnotationId[paginationItemCanvasId(entity.id)] = itemRuleId;

        paginationPageRule = paginationPageRuleId(rootRuleId);
        matchEntities.push({
            ruleId: paginationPageRule,
            source: 'node',
            expect: 'unique',
            within: itemRuleId,
            match: fromPersistentTarget(entity.pagination.pageTarget),
        });
        ruleIdByAnnotationId[paginationPageCanvasId(entity.id)] = paginationPageRule;
    }

    const annotationRule: EntityAnnotationRule = {
        ruleId: rootRuleId,
        businessTag: entity.businessTag,
        businessName: entity.name,
    };

    if (entity.kind === 'table') {
        if (entity.primaryKey) {
            annotationRule.primaryKey = {
                fieldKey: entity.primaryKey.fieldKey,
                ...(entity.primaryKey.columns ? { columns: [...entity.primaryKey.columns] } : {}),
            };
        }

        if (entity.columns.length > 0) {
            annotationRule.columns = entity.columns
                .filter((column) => column.disposition === 'active')
                .map((column) => ({
                    fieldKey: column.fieldKey,
                    ...(column.name ? { name: column.name } : {}),
                    ...(column.kind ? { kind: column.kind } : {}),
                    ...(column.actions.length > 0
                        ? {
                            actions: column.actions
                                .filter((action) => action.disposition === 'active')
                                .map((action) => ({
                                    actionIntent: action.actionIntent,
                                    ...(action.text ? { text: action.text } : {}),
                                })),
                        }
                        : {}),
                }));
        }

        if (entity.pagination && paginationPageRule) {
            annotationRule.pagination = {
                nextAction: {
                    actionIntent: entity.pagination.actionIntent,
                    nodeRuleId: paginationPageRule,
                },
            };
        }
    }

    if (entity.kind === 'form') {
        const fields = entity.annotations.filter((annotation): annotation is CanvasAnnotationDraft =>
            annotation.type === 'field' && annotation.disposition === 'active',
        );
        const actions = entity.annotations.filter((annotation): annotation is CanvasAnnotationDraft =>
            annotation.type === 'action' && annotation.disposition === 'active',
        );

        if (fields.length > 0) {
            annotationRule.fields = fields.map((field) => {
                const fieldRuleId = annotationRuleIdByCanvasId.get(field.id);
                const compiledField = {
                    fieldKey: field.businessKey,
                    ...(field.name ? { name: field.name } : {}),
                    ...(fieldRuleId ? { controlRuleId: fieldRuleId } : {}),
                };
                refTargetByCanvasId[field.id] = compiledField;
                return compiledField;
            });
        }
        if (actions.length > 0) {
            annotationRule.actions = actions.map((action) => {
                const annRuleId = annotationRuleIdByCanvasId.get(action.id);
                return {
                    actionIntent: action.businessKey,
                    ...(action.name ? { text: action.name } : {}),
                    ...(annRuleId ? { nodeRuleId: annRuleId } : {}),
                };
            });
        }
    }

    if (entity.kind === 'table') {
        const actionAnnotations = entity.annotations.filter((annotation) =>
            annotation.type === 'action' && annotation.disposition === 'active',
        );
        if (actionAnnotations.length > 0 && !annotationRule.actions) {
            annotationRule.actions = actionAnnotations.map((action) => {
                const annRuleId = annotationRuleIdByCanvasId.get(action.id);
                return {
                    actionIntent: action.businessKey,
                    ...(action.name ? { text: action.name } : {}),
                    ...(annRuleId ? { nodeRuleId: annRuleId } : {}),
                };
            });
        }
    }

    refTargetByCanvasId[entity.id] = annotationRule;
    return annotationRule;
};

export const compileCanvasDraft = (draft: CanvasDraft): CompileResult => {
    const canvasValidation = validateCanvasDraft(draft);
    if (!canvasValidation.ok) {
        return { ok: false, errors: canvasValidation.errors };
    }

    const matchEntities: EntityMatchRule[] = [];
    const annotationRules: EntityAnnotationRule[] = [];
    const ruleIdByEntityId: Record<string, string> = {};
    const ruleIdByAnnotationId: Record<string, string> = {};
    const refTargetByCanvasId: Record<string, Record<string, unknown>> = {};

    draft.entities.forEach((entity, entityIdx) => {
        const annotationRule = compileEntity(
            entity,
            entityIdx,
            matchEntities,
            ruleIdByEntityId,
            ruleIdByAnnotationId,
            refTargetByCanvasId,
        );
        annotationRules.push(annotationRule);
    });

    const canvasIdToRuleId: Record<string, string> = { ...ruleIdByEntityId, ...ruleIdByAnnotationId };
    const ruleIdToCanvasId = draft.preserved.ruleIdToCanvasId;

    const rewriteRuleId = (originalRuleId: string): string | undefined => {
        const canvasId = ruleIdToCanvasId[originalRuleId];
        if (!canvasId) {return undefined;}
        return canvasIdToRuleId[canvasId];
    };

    const locatorEmission = emitPreservedLocatorRules(draft.preserved, rewriteRuleId);
    if (locatorEmission.conflicts.length > 0) {
        return { ok: false, errors: locatorEmission.conflicts };
    }
    for (const rule of locatorEmission.rules) {
        matchEntities.push(rule);
    }

    const matchSet: EntityRuleSet = {
        version: 1,
        page: {
            kind: draft.page.kind,
            ...(draft.page.urlPattern ? { urlPattern: draft.page.urlPattern } : {}),
        },
        entities: matchEntities,
    };
    const annotationSet: EntityAnnotationSet = {
        version: 1,
        page: {
            kind: draft.page.kind,
            ...(draft.page.urlPattern ? { urlPattern: draft.page.urlPattern } : {}),
        },
        annotations: annotationRules,
    };

    const mergeResult = mergePreserved(annotationSet, canvasIdToRuleId, draft.preserved);
    const refConflicts = applyPreservedRuleRefs(refTargetByCanvasId, locatorEmission.ruleIdByPreservedKey, draft.preserved);
    const conflicts = [...mergeResult.conflicts, ...refConflicts];
    if (conflicts.length > 0) {
        return { ok: false, errors: conflicts };
    }

    const artifact: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: draft.profileName,
        match: matchSet,
        annotation: annotationSet,
    };

    const validated = validateEntityRules(artifact.name, artifact.match, artifact.annotation);
    if (!validated.ok) {
        return { ok: false, errors: validated.errors };
    }

    return {
        ok: true,
        artifact,
        ruleIdByAnnotationId,
        ruleIdByEntityId,
    };
};
