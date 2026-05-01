import { entityAnnotationSetSchema, entityMatchRuleSetSchema } from './schema';
import type {
    EntityAnnotationSet,
    EntityMatchRule,
    EntityRuleSet,
    NormalizedEntityRuleBundle,
    ValidateEntityRulesResult,
} from './types';

export const validateEntityRules = (
    id: string,
    matchRaw: unknown,
    annotationRaw: unknown,
): ValidateEntityRulesResult => {
    const errors: string[] = [];

    const parsedMatch = entityMatchRuleSetSchema.safeParse(matchRaw);
    if (!parsedMatch.success) {
        errors.push(...parsedMatch.error.issues.map((issue) => `match: ${issue.path.join('.')} ${issue.message}`.trim()));
    }

    const parsedAnnotation = entityAnnotationSetSchema.safeParse(annotationRaw);
    if (!parsedAnnotation.success) {
        errors.push(...parsedAnnotation.error.issues.map((issue) => `annotation: ${issue.path.join('.')} ${issue.message}`.trim()));
    }

    if (!parsedMatch.success || !parsedAnnotation.success) {
        return { ok: false, errors };
    }

    const matchSet = parsedMatch.data as EntityRuleSet;
    const annotationSet = parsedAnnotation.data as EntityAnnotationSet;

    if (matchSet.page.kind !== annotationSet.page.kind) {
        errors.push(`page.kind mismatch: match=${matchSet.page.kind}, annotation=${annotationSet.page.kind}`);
    }

    const matchRuleById = new Map<string, EntityMatchRule>();
    for (const rule of matchSet.entities) {
        if (matchRuleById.has(rule.ruleId)) {
            errors.push(`duplicate match ruleId: ${rule.ruleId}`);
            continue;
        }
        matchRuleById.set(rule.ruleId, rule);
    }

    const annotationRuleIds = new Set<string>();
    for (const rule of annotationSet.annotations) {
        if (annotationRuleIds.has(rule.ruleId)) {
            errors.push(`duplicate annotation ruleId: ${rule.ruleId}`);
        }
        annotationRuleIds.add(rule.ruleId);

        if (!matchRuleById.has(rule.ruleId)) {
            errors.push(`annotation.ruleId not found in match rules: ${rule.ruleId}`);
        }

        const columnFieldKeys = new Set<string>();
        const columnActionIntents = new Set<string>();
        for (const column of rule.columns || []) {
            if (columnFieldKeys.has(column.fieldKey)) {
                errors.push(`duplicate column fieldKey for ruleId=${rule.ruleId}: ${column.fieldKey}`);
            }
            columnFieldKeys.add(column.fieldKey);

            if ((column.actions?.length || 0) > 0 && column.kind !== 'action_column') {
                errors.push(`column.actions requires kind=action_column for ruleId=${rule.ruleId}: ${column.fieldKey}`);
            }

            const columnActionIntentSet = new Set<string>();
            for (const action of column.actions || []) {
                if (columnActionIntentSet.has(action.actionIntent)) {
                    errors.push(`duplicate column actionIntent for ruleId=${rule.ruleId}: ${action.actionIntent}`);
                }
                columnActionIntentSet.add(action.actionIntent);
                if (columnActionIntents.has(action.actionIntent)) {
                    errors.push(`duplicate column actionIntent for ruleId=${rule.ruleId}: ${action.actionIntent}`);
                }
                columnActionIntents.add(action.actionIntent);
            }
        }
        if (rule.primaryKey?.fieldKey && columnFieldKeys.size > 0 && !columnFieldKeys.has(rule.primaryKey.fieldKey)) {
            errors.push(`primaryKey.fieldKey must appear in columns for ruleId=${rule.ruleId}`);
        }

        const fieldKeys = new Set<string>();
        for (const field of rule.fields || []) {
            if (fieldKeys.has(field.fieldKey)) {
                errors.push(`duplicate fieldKey for ruleId=${rule.ruleId}: ${field.fieldKey}`);
            }
            fieldKeys.add(field.fieldKey);

            if (field.controlRuleId && !matchRuleById.has(field.controlRuleId)) {
                errors.push(`field.controlRuleId not found for ruleId=${rule.ruleId}: ${field.controlRuleId}`);
            }
            if (field.labelRuleId && !matchRuleById.has(field.labelRuleId)) {
                errors.push(`field.labelRuleId not found for ruleId=${rule.ruleId}: ${field.labelRuleId}`);
            }
            if (field.optionSource?.optionRuleId && !matchRuleById.has(field.optionSource.optionRuleId)) {
                errors.push(`field.optionSource.optionRuleId not found for ruleId=${rule.ruleId}: ${field.optionSource.optionRuleId}`);
            }
        }

        const actionIntents = new Set<string>();
        for (const action of rule.actions || []) {
            if (actionIntents.has(action.actionIntent)) {
                errors.push(`duplicate actionIntent for ruleId=${rule.ruleId}: ${action.actionIntent}`);
            }
            actionIntents.add(action.actionIntent);
            if (action.nodeRuleId && !matchRuleById.has(action.nodeRuleId)) {
                errors.push(`action.nodeRuleId not found for ruleId=${rule.ruleId}: ${action.nodeRuleId}`);
            }
        }

        if (rule.pagination) {
            if (annotationSet.page.kind !== 'table') {
                errors.push(`pagination only allowed for table annotations: ${rule.ruleId}`);
            }
            const nextAction = rule.pagination.nextAction;
            if (!nextAction) {
                errors.push(`pagination.nextAction is required for ruleId=${rule.ruleId}`);
                continue;
            }
            if (!nextAction.actionIntent.trim()) {
                errors.push(`pagination.nextAction.actionIntent must be non-empty for ruleId=${rule.ruleId}`);
            }
            if (!matchRuleById.has(nextAction.nodeRuleId)) {
                errors.push(`pagination.nextAction.nodeRuleId not found for ruleId=${rule.ruleId}: ${nextAction.nodeRuleId}`);
            }
            if (nextAction.disabledRuleId && !matchRuleById.has(nextAction.disabledRuleId)) {
                errors.push(
                    `pagination.nextAction.disabledRuleId not found for ruleId=${rule.ruleId}: ${nextAction.disabledRuleId}`,
                );
            }
        }
    }

    const adjacency = new Map<string, string>();
    for (const rule of matchSet.entities) {
        if (!rule.within) {continue;}
        if (!matchRuleById.has(rule.within)) {
            errors.push(`within target not found: ${rule.ruleId} -> ${rule.within}`);
            continue;
        }
        adjacency.set(rule.ruleId, rule.within);
    }

    const cycle = detectWithinCycle(adjacency);
    if (cycle.length > 0) {
        errors.push(`within cycle detected: ${cycle.join(' -> ')}`);
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    const annotationByRuleId: NormalizedEntityRuleBundle['annotationByRuleId'] = {};
    for (const annotation of annotationSet.annotations) {
        annotationByRuleId[annotation.ruleId] = annotation;
    }

    const bundle: NormalizedEntityRuleBundle = {
        id,
        page: {
            kind: matchSet.page.kind,
            urlPattern: matchSet.page.urlPattern,
        },
        matchRules: matchSet.entities.map((rule, order) => ({ ...rule, order })),
        annotationByRuleId,
    };

    return {
        ok: true,
        bundle,
    };
};

const detectWithinCycle = (adjacency: Map<string, string>): string[] => {
    const visiting = new Set<string>();
    const visited = new Set<string>();

    for (const node of adjacency.keys()) {
        const cycle = dfs(node, adjacency, visiting, visited, []);
        if (cycle.length > 0) {
            return cycle;
        }
    }

    return [];
};

const dfs = (
    node: string,
    adjacency: Map<string, string>,
    visiting: Set<string>,
    visited: Set<string>,
    path: string[],
): string[] => {
    if (visited.has(node)) {return [];}
    if (visiting.has(node)) {
        const start = path.indexOf(node);
        if (start < 0) {return [node, node];}
        return [...path.slice(start), node];
    }

    visiting.add(node);
    const nextPath = [...path, node];
    const target = adjacency.get(node);
    if (target) {
        const cycle = dfs(target, adjacency, visiting, visited, nextPath);
        if (cycle.length > 0) {
            return cycle;
        }
    }

    visiting.delete(node);
    visited.add(node);
    return [];
};
