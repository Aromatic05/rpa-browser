import type {
    EntityAnnotationRule,
    EntityAnnotationSet,
    EntityMatchRule,
    EntityRuleSet,
} from '../../runner/steps/executors/snapshot/entity_rules/types';
import type {
    CanvasAnnotationDraft,
    CanvasColumnActionDraft,
    CanvasColumnDraft,
    CanvasDraft,
    CanvasEntityDraft,
    CanvasPaginationDraft,
    CanvasPrimaryKeyDraft,
    PersistentTargetDraft,
} from './types';
import {
    annotationCanvasId,
    columnActionCanvasId,
    columnCanvasId,
    entityCanvasId,
    paginationItemCanvasId,
    paginationPageCanvasId,
} from './identifiers';
import { captureLocatorRulesAndRefs, capturePreservedByCanvasId } from './preserved';

const toPersistentTarget = (match: EntityMatchRule['match']): PersistentTargetDraft => {
    const target: PersistentTargetDraft = {};
    if (match.kind) {target.kind = match.kind;}
    if (match.nameContains) {target.nameContains = match.nameContains;}
    if (match.classContains) {target.classContains = match.classContains;}
    if (match.textContains) {target.textContains = match.textContains;}
    if (match.ariaContains) {target.ariaContains = match.ariaContains;}
    if (match.keyHint) {target.keyHint = match.keyHint;}
    if (match.relation) {target.relation = match.relation;}
    return target;
};

const isEntityRoot = (rule: EntityMatchRule): boolean => rule.source === 'region' || rule.source === 'group';

type PaginationChain = {
    itemRule?: EntityMatchRule;
    pageRule?: EntityMatchRule;
    annotationRuleId: string;
    actionIntent: string;
};

const collectPaginationChains = (
    matchSet: EntityRuleSet,
    annotationSet: EntityAnnotationSet,
): Map<string, PaginationChain> => {
    const matchRuleById = new Map<string, EntityMatchRule>();
    for (const rule of matchSet.entities) {
        matchRuleById.set(rule.ruleId, rule);
    }

    const chains = new Map<string, PaginationChain>();
    for (const annotationRule of annotationSet.annotations) {
        const nextAction = annotationRule.pagination?.nextAction;
        if (!nextAction) {continue;}
        const pageRule = nextAction.nodeRuleId ? matchRuleById.get(nextAction.nodeRuleId) : undefined;
        const itemRule = pageRule?.within ? matchRuleById.get(pageRule.within) : undefined;
        chains.set(annotationRule.ruleId, {
            itemRule,
            pageRule,
            annotationRuleId: annotationRule.ruleId,
            actionIntent: nextAction.actionIntent,
        });
    }
    return chains;
};

const findActionChildRule = (
    childRules: EntityMatchRule[],
    annotationByRuleId: Map<string, EntityAnnotationRule | undefined>,
    actionIntent: string,
    text: string | undefined,
): EntityMatchRule | undefined => {
    for (const rule of childRules) {
        const ann = annotationByRuleId.get(rule.ruleId);
        if (ann?.actionIntent && ann.actionIntent === actionIntent) {return rule;}
    }
    if (text) {
        for (const rule of childRules) {
            if (rule.match.textContains && rule.match.textContains === text) {return rule;}
        }
    }
    return undefined;
};

type EntityBuildContext = {
    entityId: string;
    rootRule: EntityMatchRule;
    rootAnnotation?: EntityAnnotationRule;
    childRules: EntityMatchRule[];
    annotationByRuleId: Map<string, EntityAnnotationRule | undefined>;
    paginationChain?: PaginationChain;
    ruleIdToCanvasId: Record<string, string>;
};

const buildEntity = (ctx: EntityBuildContext): CanvasEntityDraft => {
    const { entityId, rootRule, rootAnnotation, childRules, annotationByRuleId, paginationChain, ruleIdToCanvasId } = ctx;
    const kind = rootRule.match.kind || 'table';

    const target = toPersistentTarget(rootRule.match);
    ruleIdToCanvasId[rootRule.ruleId] = entityId;

    const columns: CanvasColumnDraft[] = [];
    const annotations: CanvasAnnotationDraft[] = [];

    const isFormEntity = kind === 'form';
    const isTableEntity = kind === 'table';

    if (rootAnnotation?.columns) {
        for (let colIndex = 0; colIndex < rootAnnotation.columns.length; colIndex++) {
            const col = rootAnnotation.columns[colIndex];
            const columnId = columnCanvasId(entityId, colIndex);
            const actions: CanvasColumnActionDraft[] = (col.actions || []).map((action, actionIndex) => {
                const childRule = findActionChildRule(childRules, annotationByRuleId, action.actionIntent, action.text);
                const actionCanvasId = columnActionCanvasId(entityId, colIndex, actionIndex);
                if (childRule) {
                    ruleIdToCanvasId[childRule.ruleId] = actionCanvasId;
                }
                return {
                    id: actionCanvasId,
                    actionIntent: action.actionIntent,
                    ...(action.text ? { text: action.text } : {}),
                    target: childRule ? toPersistentTarget(childRule.match) : {},
                    origin: 'confirmed' as const,
                    disposition: 'active' as const,
                };
            });

            if (isFormEntity) {
                annotations.push({
                    id: columnId,
                    type: 'field',
                    businessKey: col.fieldKey,
                    ...(col.name ? { name: col.name } : {}),
                    target: {},
                    expect: 'unique',
                    origin: 'confirmed' as const,
                    disposition: 'active' as const,
                });
            } else if (isTableEntity) {
                columns.push({
                    id: columnId,
                    fieldKey: col.fieldKey,
                    ...(col.name ? { name: col.name } : {}),
                    ...(col.kind ? { kind: col.kind } : {}),
                    actions,
                    origin: 'confirmed' as const,
                    disposition: 'active' as const,
                });
            }
        }
    }

    if (rootAnnotation?.fields) {
        for (let fieldIndex = 0; fieldIndex < rootAnnotation.fields.length; fieldIndex++) {
            const field = rootAnnotation.fields[fieldIndex];
            annotations.push({
                id: annotationCanvasId(entityId, 'field', fieldIndex),
                type: 'field',
                businessKey: field.fieldKey,
                ...(field.name ? { name: field.name } : {}),
                target: {},
                expect: 'unique',
                origin: 'confirmed' as const,
                disposition: 'active' as const,
            });
        }
    }

    let actionAnnotationIndex = 0;
    if (rootAnnotation?.actions) {
        for (const action of rootAnnotation.actions) {
            const annotationId = annotationCanvasId(entityId, 'action', actionAnnotationIndex++);
            annotations.push({
                id: annotationId,
                type: 'action',
                businessKey: action.actionIntent,
                ...(action.text ? { name: action.text } : {}),
                target: {},
                expect: 'unique',
                origin: 'confirmed' as const,
                disposition: 'active' as const,
            });
        }
    }

    const handledActionIntents = new Set(
        annotations.filter((annotation) => annotation.type === 'action').map((annotation) => annotation.businessKey),
    );
    for (const child of childRules) {
        const childAnnotationRule = annotationByRuleId.get(child.ruleId);
        if (!childAnnotationRule?.actionIntent) {continue;}
        if (handledActionIntents.has(childAnnotationRule.actionIntent)) {continue;}
        handledActionIntents.add(childAnnotationRule.actionIntent);
        const annotationId = annotationCanvasId(entityId, 'action', actionAnnotationIndex++);
        ruleIdToCanvasId[child.ruleId] = annotationId;
        annotations.push({
            id: annotationId,
            type: 'action',
            businessKey: childAnnotationRule.actionIntent,
            target: toPersistentTarget(child.match),
            expect: child.expect,
            origin: 'confirmed' as const,
            disposition: 'active' as const,
        });
    }

    let primaryKey: CanvasPrimaryKeyDraft | undefined;
    if (rootAnnotation?.primaryKey) {
        primaryKey = {
            fieldKey: rootAnnotation.primaryKey.fieldKey,
            ...(rootAnnotation.primaryKey.columns ? { columns: [...rootAnnotation.primaryKey.columns] } : {}),
        };
    }

    let pagination: CanvasPaginationDraft | undefined;
    if (paginationChain) {
        const pageCanvasId = paginationPageCanvasId(entityId);
        const itemCanvasId = paginationItemCanvasId(entityId);
        if (paginationChain.pageRule) {
            ruleIdToCanvasId[paginationChain.pageRule.ruleId] = pageCanvasId;
        }
        if (paginationChain.itemRule) {
            ruleIdToCanvasId[paginationChain.itemRule.ruleId] = itemCanvasId;
        }
        pagination = {
            actionIntent: paginationChain.actionIntent,
            pageTarget: paginationChain.pageRule ? toPersistentTarget(paginationChain.pageRule.match) : {},
            ...(paginationChain.itemRule ? { itemTarget: toPersistentTarget(paginationChain.itemRule.match) } : {}),
        };
    }

    return {
        id: entityId,
        source: rootRule.source === 'group' ? 'group' : 'region',
        kind,
        name: rootAnnotation?.businessName || rootRule.ruleId,
        businessTag: rootAnnotation?.businessTag || rootRule.ruleId,
        target,
        expect: rootRule.expect,
        annotations,
        ...(primaryKey ? { primaryKey } : {}),
        columns,
        ...(pagination ? { pagination } : {}),
        origin: 'confirmed',
    };
};

export const importEntityRulesToCanvasDraft = (artifact: {
    kind: 'entity_rules';
    name: string;
    match: unknown;
    annotation: unknown;
}): CanvasDraft => {
    const matchSet = artifact.match as EntityRuleSet;
    const annotationSet = artifact.annotation as EntityAnnotationSet;

    const annotationByRuleId = new Map<string, EntityAnnotationRule | undefined>();
    for (const rule of annotationSet.annotations) {
        annotationByRuleId.set(rule.ruleId, rule);
    }

    const paginationChains = collectPaginationChains(matchSet, annotationSet);
    const paginationConsumedRuleIds = new Set<string>();
    for (const chain of paginationChains.values()) {
        if (chain.itemRule) {paginationConsumedRuleIds.add(chain.itemRule.ruleId);}
        if (chain.pageRule) {paginationConsumedRuleIds.add(chain.pageRule.ruleId);}
    }

    const roots = matchSet.entities.filter((rule) => isEntityRoot(rule));

    const ruleIdToCanvasId: Record<string, string> = {};
    const entities: CanvasEntityDraft[] = [];

    roots.forEach((root, entityIndex) => {
        const entityId = entityCanvasId(entityIndex);
        const childRules = matchSet.entities.filter((rule) =>
            rule.source === 'node' &&
            rule.within === root.ruleId &&
            !paginationConsumedRuleIds.has(rule.ruleId),
        );

        entities.push(buildEntity({
            entityId,
            rootRule: root,
            rootAnnotation: annotationByRuleId.get(root.ruleId),
            childRules,
            annotationByRuleId,
            paginationChain: paginationChains.get(root.ruleId),
            ruleIdToCanvasId,
        }));
    });

    const preservedByCanvasId = capturePreservedByCanvasId(annotationSet, ruleIdToCanvasId);
    const { locatorRules, ruleRefs } = captureLocatorRulesAndRefs(matchSet, annotationSet, ruleIdToCanvasId);

    return {
        version: 1,
        profileName: artifact.name,
        page: {
            kind: matchSet.page.kind,
            ...(matchSet.page.urlPattern ? { urlPattern: matchSet.page.urlPattern } : {}),
        },
        entities,
        preserved: {
            matchRaw: artifact.match,
            annotationRaw: artifact.annotation,
            preservedByCanvasId,
            ruleIdToCanvasId,
            locatorRules,
            ruleRefs,
        },
    };
};
