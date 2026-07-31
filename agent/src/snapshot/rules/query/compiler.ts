import { deepFreeze } from '../../observation/model/freeze';
import type {
    EntityRuleQueryDomain,
    EntityRuleQueryInputRule,
    EntityRuleQueryPlan,
    QueryPlanCompileResult,
    QueryPlanDiagnostic,
} from './contracts';

export type CompileEntityRuleQueryPlanInput = {
    profileName: string;
    domain?: EntityRuleQueryDomain;
    rules: readonly EntityRuleQueryInputRule[];
};

const COMMON_MATCH_KEYS = new Set([
    'kind',
    'nameContains',
    'idEquals',
    'nameEquals',
    'roleEquals',
    'placeholderEquals',
    'classContains',
    'textContains',
    'ariaContains',
]);
const TABLE_MATCH_KEYS = new Set([...COMMON_MATCH_KEYS, 'relation', 'keyHint']);
const STRING_MATCH_KEYS = [
    'nameContains',
    'idEquals',
    'nameEquals',
    'roleEquals',
    'placeholderEquals',
    'classContains',
    'textContains',
    'ariaContains',
] as const;

export const compileEntityRuleQueryPlan = (
    input: CompileEntityRuleQueryPlanInput,
): QueryPlanCompileResult => {
    const profileName = input.profileName.trim();
    const diagnostics: QueryPlanDiagnostic[] = [];
    if (!profileName) {
        diagnostics.push(compileDiagnostic('', 'query-plan.profile.invalid', 'query plan profile name is empty'));
    }

    const byRuleId = new Map<string, EntityRuleQueryInputRule>();
    for (const rule of input.rules) {
        if (byRuleId.has(rule.ruleId)) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.rule.duplicate',
                `duplicate query plan ruleId: ${rule.ruleId}`,
                rule,
            ));
        } else {
            byRuleId.set(rule.ruleId, rule);
        }
        if (!hasMatchCondition(rule.match)) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.match.empty',
                `query plan rule has no match condition: ${rule.ruleId}`,
                rule,
            ));
        }
    }
    for (const rule of input.rules) {
        if (rule.within && !byRuleId.has(rule.within)) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.within.missing',
                `query plan within target does not exist: ${rule.ruleId} -> ${rule.within}`,
                rule,
            ));
        }
        if (rule.contains && !byRuleId.has(rule.contains)) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.contains.missing',
                `query plan contains target does not exist: ${rule.ruleId} -> ${rule.contains}`,
                rule,
            ));
        }
    }
    const cycle = findDependencyCycle(byRuleId);
    if (cycle.length > 0) {
        const rule = byRuleId.get(cycle[0]);
        const containsCycle = cycle.some((ruleId, index) => {
            const next = cycle[index + 1];
            return Boolean(next && byRuleId.get(ruleId)?.contains === next);
        });
        diagnostics.push(compileDiagnostic(
            profileName,
            containsCycle ? 'query-plan.dependency.cycle' : 'query-plan.within.cycle',
            `query plan dependency cycle: ${cycle.join(' -> ')}`,
            rule,
        ));
    }

    const domains = new Set<EntityRuleQueryDomain>();
    if (input.domain) {domains.add(input.domain);}
    for (const rule of input.rules) {
        const kind = rule.match.kind;
        if (kind === 'form' || kind === 'table') {domains.add(kind);}
        else if (kind === 'dialog' || kind === 'list' || kind === 'panel' || kind === 'toolbar' || kind === 'kv') {
            domains.add('node');
        }
    }
    if (domains.size === 0) {
        diagnostics.push(compileDiagnostic(
            profileName,
            'query-plan.domain.missing',
            `query plan has no form or table root: ${profileName}`,
        ));
    }
    if (domains.size > 1) {
        diagnostics.push(compileDiagnostic(
            profileName,
            'query-plan.domain.mixed',
            `query plan mixes form and table roots: ${profileName}`,
        ));
    }
    const domain = domains.size === 1 ? [...domains][0] : undefined;
    if (domain) {
        for (const rule of input.rules) {
            diagnostics.push(...validateMatch(profileName, rule, domain));
        }
    } else {
        for (const rule of input.rules) {
            const unsupported = Object.keys(rule.match).filter((key) => !TABLE_MATCH_KEYS.has(key));
            if (unsupported.length > 0) {
                diagnostics.push(compileDiagnostic(
                    profileName,
                    'query-plan.match.unsupported',
                    `unsupported query plan conditions in ${profileName}/${rule.ruleId}: ${unsupported.join(', ')}`,
                    rule,
                ));
            }
        }
    }

    if (diagnostics.length > 0 || !domain) {
        return deepFreeze({ ok: false, diagnostics });
    }

    const orderedRules = orderRules(input.rules);
    const plan: EntityRuleQueryPlan = {
        id: profileName,
        profileName,
        domain,
        steps: orderedRules.map((rule, order) => ({
            planStepId: stepId(profileName, rule.ruleId),
            order,
            ruleId: rule.ruleId,
            domain,
            source: rule.source,
            expect: rule.expect,
            withinRuleId: rule.within,
            withinPlanStepId: rule.within ? stepId(profileName, rule.within) : undefined,
            containsRuleId: rule.contains,
            containsPlanStepId: rule.contains ? stepId(profileName, rule.contains) : undefined,
            match: structuredClone(rule.match),
        })),
    };
    return deepFreeze({ ok: true, plan, diagnostics: [] });
};


const describeUnknown = (value: unknown): string => {
    if (typeof value === 'string') {return value;}
    if (value === undefined) {return 'undefined';}
    if (value === null) {return 'null';}
    try {
        const serialized = JSON.stringify(value);
        return typeof serialized === 'string' ? serialized : typeof value;
    } catch {
        return Object.prototype.toString.call(value);
    }
};

const validateMatch = (
    profileName: string,
    rule: EntityRuleQueryInputRule,
    domain: EntityRuleQueryDomain,
): QueryPlanDiagnostic[] => {
    const diagnostics: QueryPlanDiagnostic[] = [];
    const allowedKeys = domain === 'table' ? TABLE_MATCH_KEYS : COMMON_MATCH_KEYS;
    const unsupported = Object.keys(rule.match).filter((key) => !allowedKeys.has(key));
    if (unsupported.length > 0) {
        diagnostics.push(compileDiagnostic(
            profileName,
            'query-plan.match.unsupported',
            `unsupported query plan conditions in ${profileName}/${rule.ruleId}: ${unsupported.join(', ')}`,
            rule,
        ));
    }
    if (rule.match.kind !== undefined) {
        const kind = rule.match.kind;
        const compatible = typeof kind === 'string' && (domain === 'node'
            ? kind !== 'form' && kind !== 'table'
            : kind === domain);
        if (!compatible) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.domain.mixed',
                `rule ${profileName}/${rule.ruleId} targets ${describeUnknown(rule.match.kind)} inside a ${domain} plan`,
                rule,
            ));
        }
    }
    for (const key of STRING_MATCH_KEYS) {
        const value = rule.match[key];
        if (value !== undefined && typeof value !== 'string') {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.match.invalid',
                `query plan condition ${profileName}/${rule.ruleId}.${key} must be a string`,
                rule,
            ));
        }
    }
    if (domain === 'table') {
        if (rule.match.relation !== undefined && rule.match.relation !== 'pagination') {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.match.invalid',
                `query plan condition ${profileName}/${rule.ruleId}.relation is invalid`,
                rule,
            ));
        }
        if (rule.match.keyHint !== undefined && !validKeyHint(rule.match.keyHint)) {
            diagnostics.push(compileDiagnostic(
                profileName,
                'query-plan.match.invalid',
                `query plan condition ${profileName}/${rule.ruleId}.keyHint is invalid`,
                rule,
            ));
        }
    }
    return diagnostics;
};

const hasMatchCondition = (match: Readonly<Record<string, unknown>>): boolean => Object.values(match)
    .some((value) => typeof value === 'string' ? value.trim().length > 0 : Boolean(value));

const validKeyHint = (value: unknown): boolean => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {return false;}
    const record = value as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'headerContainsAll' && key !== 'primaryKeyCandidatesContains')) {
        return false;
    }
    return ['headerContainsAll', 'primaryKeyCandidatesContains'].every((key) => {
        const item = record[key];
        return item === undefined || (Array.isArray(item) && item.every((entry) => typeof entry === 'string'));
    });
};

const dependencyIds = (rule: EntityRuleQueryInputRule): string[] =>
    [...new Set([rule.within, rule.contains].filter((value): value is string => Boolean(value)))];

const orderRules = (rules: readonly EntityRuleQueryInputRule[]): EntityRuleQueryInputRule[] => {
    const byId = new Map(rules.map((rule) => [rule.ruleId, rule]));
    const ordered: EntityRuleQueryInputRule[] = [];
    const visited = new Set<string>();
    const visit = (rule: EntityRuleQueryInputRule): void => {
        if (visited.has(rule.ruleId)) {return;}
        for (const dependencyId of dependencyIds(rule)) {
            const dependency = byId.get(dependencyId);
            if (dependency) {visit(dependency);}
        }
        visited.add(rule.ruleId);
        ordered.push(rule);
    };
    rules.forEach(visit);
    return ordered;
};

const findDependencyCycle = (byId: ReadonlyMap<string, EntityRuleQueryInputRule>): string[] => {
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const path: string[] = [];
    const visit = (ruleId: string): string[] => {
        if (visiting.has(ruleId)) {
            const start = path.indexOf(ruleId);
            return [...path.slice(Math.max(0, start)), ruleId];
        }
        if (visited.has(ruleId)) {return [];}
        visiting.add(ruleId);
        path.push(ruleId);
        for (const dependencyId of dependencyIds(byId.get(ruleId)!)) {
            if (!byId.has(dependencyId)) {continue;}
            const cycle = visit(dependencyId);
            if (cycle.length > 0) {return cycle;}
        }
        path.pop();
        visiting.delete(ruleId);
        visited.add(ruleId);
        return [];
    };
    for (const ruleId of byId.keys()) {
        const cycle = visit(ruleId);
        if (cycle.length > 0) {return cycle;}
    }
    return [];
};

const compileDiagnostic = (
    profileName: string,
    code: string,
    message: string,
    rule?: Pick<EntityRuleQueryInputRule, 'ruleId'>,
): QueryPlanDiagnostic => ({
    code,
    severity: 'error',
    stage: 'query-plan-compile',
    status: 'rejected',
    nodeIds: [],
    evidence: [],
    message,
    profileName,
    planStepId: rule ? stepId(profileName, rule.ruleId) : undefined,
    ruleId: rule?.ruleId,
    targetKind: 'query-plan',
});

const stepId = (profileName: string, ruleId: string): string => `${profileName}:${ruleId}`;
