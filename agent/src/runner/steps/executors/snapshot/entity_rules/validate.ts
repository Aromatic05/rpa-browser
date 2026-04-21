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

        const columnFieldKeys = new Set((rule.columns || []).map((column) => column.fieldKey));
        if (rule.primaryKey?.fieldKey && columnFieldKeys.size > 0 && !columnFieldKeys.has(rule.primaryKey.fieldKey)) {
            errors.push(`primaryKey.fieldKey must appear in columns for ruleId=${rule.ruleId}`);
        }
    }

    const adjacency = new Map<string, string>();
    for (const rule of matchSet.entities) {
        if (!rule.within) continue;
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
    if (visited.has(node)) return [];
    if (visiting.has(node)) {
        const start = path.indexOf(node);
        if (start < 0) return [node, node];
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
