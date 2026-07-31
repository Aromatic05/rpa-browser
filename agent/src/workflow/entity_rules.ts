import path from 'node:path';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import {
    listDirectories,
    readYamlFile,
    removePath,
    requireArtifactName,
    workflowArtifactPath,
    workflowRootDir,
    writeYamlFile,
} from './fs';
import type { WorkflowCodec } from './store';

export type EntityRulePageKind = 'form' | 'table' | 'dialog' | 'list' | 'panel' | 'toolbar' | 'kv';

export type EntityRulePageApplicability = {
    kind: EntityRulePageKind;
    urlPattern?: string;
};

export type EntityRuleMatchRecord = {
    ruleId: string;
    source: 'region' | 'group' | 'node';
    expect: 'unique' | 'one_or_more';
    within?: string;
    contains?: string;
    match: Readonly<Record<string, unknown>>;
};

export type EntityRuleMatchArtifact = {
    version: 2;
    rules: EntityRuleMatchRecord[];
};

export type EntityRuleAnnotationBinding = {
    ruleId: string;
    [key: string]: unknown;
};

export type EntityRuleAnnotationArtifact = {
    version: 2;
    bindings: EntityRuleAnnotationBinding[];
};

export type WorkflowEntityRules = {
    kind: 'entity_rules';
    name: string;
    page?: EntityRulePageApplicability;
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
};

export type EntityRuleBundle = {
    id: string;
    page?: EntityRulePageApplicability;
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
};

const entityRuleDirectory = (workflowName: string, profileName: string): string =>
    workflowArtifactPath(workflowName, 'entity_rules', requireArtifactName(profileName, 'entity-rule profile name'));

export const validateWorkflowEntityRules = (value: unknown): WorkflowEntityRules => {
    if (!isRecord(value) || value.kind !== 'entity_rules') {
        throw invalidArtifact('artifact kind must be entity_rules');
    }
    const name = requireProfileName(value.name);
    const page = value.page === undefined ? undefined : validatePageApplicability(value.page, 'page');
    const match = validateMatchArtifact(value.match);
    const annotation = validateAnnotationArtifact(value.annotation, new Set(match.rules.map((rule) => rule.ruleId)));
    return {
        kind: 'entity_rules',
        name,
        page,
        match,
        annotation,
    };
};


export const importWorkflowEntityRules = (value: unknown): WorkflowEntityRules => {
    if (!isRecord(value) || value.kind !== 'entity_rules') {
        throw invalidArtifact('artifact kind must be entity_rules');
    }
    if (isRecord(value.match) && value.match.version === 2) {
        return validateWorkflowEntityRules(value);
    }
    if (!isLegacyMatchArtifact(value.match) || !isLegacyAnnotationArtifact(value.annotation)) {
        throw invalidArtifact('legacy artifacts must contain match.version=1 entities[] and annotation.version=1 annotations[]');
    }
    const matchPage = validatePageApplicability(value.match.page, 'match.page');
    const annotationPage = validatePageApplicability(value.annotation.page, 'annotation.page');
    const matchPageKind = matchPage.kind;
    const annotationPageKind = annotationPage.kind;
    if (matchPageKind !== annotationPageKind) {
        throw invalidArtifact(`legacy page kind mismatch: ${matchPageKind} != ${annotationPageKind}`);
    }
    const name = requireProfileName(value.name);
    const match = validateMatchArtifact({version: 2, rules: value.match.entities});
    assertLegacyPageKindPreserved(match.rules, matchPageKind);
    const annotation = validateAnnotationArtifact(
        {version: 2, bindings: normalizeLegacyAnnotations(value.annotation.annotations, match.rules)},
        new Set(match.rules.map((rule) => rule.ruleId)),
    );
    return {kind: 'entity_rules', name, page: matchPage, match, annotation};
};

export const createEntityRulesCodec = (workflowName: string): WorkflowCodec<WorkflowEntityRules> => ({
    kind: 'entity_rules',
    is: (value: unknown): value is WorkflowEntityRules => {
        try {
            validateWorkflowEntityRules(value);
            return true;
        } catch {
            return false;
        }
    },
    load: (name) => {
        const profileName = requireProfileName(name);
        const directory = entityRuleDirectory(workflowName, profileName);
        try {
            let page: unknown;
            try {
                page = readYamlFile(path.join(directory, 'page.yaml'));
            } catch {
                page = undefined;
            }
            return importWorkflowEntityRules({
                kind: 'entity_rules',
                name: profileName,
                page,
                match: readYamlFile(path.join(directory, 'match.yaml')),
                annotation: readYamlFile(path.join(directory, 'annotation.yaml')),
            });
        } catch {
            return null;
        }
    },
    list: () => listDirectories(workflowArtifactPath(workflowName, 'entity_rules'))
        .filter((name) => {
            try {
                requireArtifactName(name, 'entity-rule profile name');
                return true;
            } catch {
                return false;
            }
        })
        .map((name) => createEntityRulesCodec(workflowName).load(name))
        .filter((value): value is WorkflowEntityRules => value !== null),
    save: (value) => {
        const validated = validateWorkflowEntityRules(value);
        const directory = entityRuleDirectory(workflowName, validated.name);
        if (validated.page) {
            writeYamlFile(path.join(directory, 'page.yaml'), validated.page);
        } else {
            removePath(path.join(directory, 'page.yaml'));
        }
        writeYamlFile(path.join(directory, 'match.yaml'), validated.match);
        writeYamlFile(path.join(directory, 'annotation.yaml'), validated.annotation);
        return validated;
    },
    delete: (name) => {
        removePath(entityRuleDirectory(workflowName, requireProfileName(name)));
        return true;
    },
});

export const toEntityRuleBundle = (value: WorkflowEntityRules): EntityRuleBundle => {
    const validated = validateWorkflowEntityRules(value);
    return {
        id: validated.name,
        page: validated.page ? structuredClone(validated.page) : undefined,
        match: structuredClone(validated.match),
        annotation: structuredClone(validated.annotation),
    };
};



const normalizeLegacyAnnotations = (
    annotations: unknown[],
    rules: readonly EntityRuleMatchRecord[],
): Array<Record<string, unknown>> => {
    const byRuleId = new Map<string, Record<string, unknown>>();
    for (const value of annotations) {
        if (!isRecord(value) || typeof value.ruleId !== 'string') {continue;}
        const normalized = structuredClone(value);
        if (typeof normalized.businessName === 'string' && normalized.displayName === undefined) {
            normalized.displayName = normalized.businessName;
        }
        byRuleId.set(value.ruleId, normalized);
    }
    const ruleById = new Map(rules.map((rule) => [rule.ruleId, rule]));
    const merge = (ruleId: unknown, values: Record<string, unknown>): void => {
        if (typeof ruleId !== 'string' || !ruleById.has(ruleId)) {return;}
        byRuleId.set(ruleId, {...(byRuleId.get(ruleId) ?? {ruleId}), ...values, ruleId});
    };
    for (const root of [...byRuleId.values()]) {
        for (const field of arrayRecords(root.fields)) {
            merge(field.controlRuleId, {
                fieldKey: field.fieldKey,
                fieldName: field.name,
                controlKind: field.kind,
                optionSource: field.optionSource,
            });
            if (field.labelRuleId) {merge(field.labelRuleId, {fieldKey: field.fieldKey, fieldRole: 'label'});}
        }
        for (const action of arrayRecords(root.actions)) {
            merge(action.nodeRuleId, {actionIntent: action.actionIntent, actionText: action.text});
        }
        const pagination = isRecord(root.pagination) ? root.pagination : undefined;
        const nextAction = pagination && isRecord(pagination.nextAction) ? pagination.nextAction : undefined;
        if (nextAction) {
            merge(nextAction.nodeRuleId, {
                actionIntent: nextAction.actionIntent,
                paginationRole: 'next',
            });
            if (nextAction.disabledRuleId) {
                merge(nextAction.disabledRuleId, {paginationRole: 'next-disabled'});
            }
        }
        for (const column of arrayRecords(root.columns)) {
            for (const action of arrayRecords(column.actions)) {
                const existing = [...byRuleId.values()].find((binding) => binding.actionIntent === action.actionIntent);
                if (existing) {continue;}
                const matchedRule = rules.find((rule) => rule.within === root.ruleId
                    && typeof action.text === 'string'
                    && rule.match.textContains === action.text);
                if (matchedRule) {
                    merge(matchedRule.ruleId, {actionIntent: action.actionIntent, actionText: action.text});
                }
            }
        }
    }
    return [...byRuleId.values()];
};

const arrayRecords = (value: unknown): Array<Record<string, unknown>> =>
    Array.isArray(value) ? value.filter(isRecord) : [];

const validateMatchArtifact = (value: unknown): EntityRuleMatchArtifact => {
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.rules)) {
        throw invalidArtifact('match must contain version=2 and rules[]');
    }
    const rules = value.rules.map((rule, index) => validateMatchRule(rule, index));
    const ruleIds = new Set<string>();
    for (const rule of rules) {
        if (ruleIds.has(rule.ruleId)) {
            throw invalidArtifact(`duplicate match ruleId: ${rule.ruleId}`);
        }
        ruleIds.add(rule.ruleId);
    }
    for (const rule of rules) {
        if (rule.within && !ruleIds.has(rule.within)) {
            throw invalidArtifact(`within target not found: ${rule.ruleId} -> ${rule.within}`);
        }
        if (rule.contains && !ruleIds.has(rule.contains)) {
            throw invalidArtifact(`contains target not found: ${rule.ruleId} -> ${rule.contains}`);
        }
    }
    assertAcyclicDependencies(rules);
    return { version: 2, rules };
};

const validateMatchRule = (value: unknown, index: number): EntityRuleMatchRecord => {
    if (!isRecord(value)) {
        throw invalidArtifact(`match.rules[${index}] must be an object`);
    }
    const ruleId = requireNonEmptyString(value.ruleId, `match.rules[${index}].ruleId`);
    if (value.source !== 'region' && value.source !== 'group' && value.source !== 'node') {
        throw invalidArtifact(`match.rules[${index}].source is invalid`);
    }
    if (value.expect !== 'unique' && value.expect !== 'one_or_more') {
        throw invalidArtifact(`match.rules[${index}].expect is invalid`);
    }
    if (!isRecord(value.match) || Object.keys(value.match).length === 0) {
        throw invalidArtifact(`match.rules[${index}].match must contain at least one condition`);
    }
    const within = value.within === undefined
        ? undefined
        : requireNonEmptyString(value.within, `match.rules[${index}].within`);
    const contains = value.contains === undefined
        ? undefined
        : requireNonEmptyString(value.contains, `match.rules[${index}].contains`);
    return {
        ruleId,
        source: value.source,
        expect: value.expect,
        ...(within ? {within} : {}),
        ...(contains ? {contains} : {}),
        match: structuredClone(value.match),
    };
};

const validateAnnotationArtifact = (
    value: unknown,
    matchRuleIds: ReadonlySet<string>,
): EntityRuleAnnotationArtifact => {
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.bindings)) {
        throw invalidArtifact('annotation must contain version=2 and bindings[]');
    }
    const seen = new Set<string>();
    const bindings = value.bindings.map((binding, index) => {
        if (!isRecord(binding)) {
            throw invalidArtifact(`annotation.bindings[${index}] must be an object`);
        }
        const ruleId = requireNonEmptyString(binding.ruleId, `annotation.bindings[${index}].ruleId`);
        if (!matchRuleIds.has(ruleId)) {
            throw invalidArtifact(`annotation ruleId not found in match rules: ${ruleId}`);
        }
        if (seen.has(ruleId)) {
            throw invalidArtifact(`duplicate annotation ruleId: ${ruleId}`);
        }
        seen.add(ruleId);
        return { ...structuredClone(binding), ruleId };
    });
    return { version: 2, bindings };
};

const isLegacyMatchArtifact = (value: unknown): value is {
    version: 1;
    page: unknown;
    entities: unknown[];
} => isRecord(value) && value.version === 1 && Array.isArray(value.entities);

const isLegacyAnnotationArtifact = (value: unknown): value is {
    version: 1;
    page: unknown;
    annotations: unknown[];
} => isRecord(value) && value.version === 1 && Array.isArray(value.annotations);




const ENTITY_RULE_PAGE_KINDS = new Set<EntityRulePageKind>([
    'form', 'table', 'dialog', 'list', 'panel', 'toolbar', 'kv',
]);

const validatePageApplicability = (value: unknown, field: string): EntityRulePageApplicability => {
    if (!isRecord(value) || typeof value.kind !== 'string'
        || !ENTITY_RULE_PAGE_KINDS.has(value.kind as EntityRulePageKind)) {
        throw invalidArtifact(`${field}.kind is invalid`);
    }
    const urlPattern = value.urlPattern === undefined
        ? undefined
        : requireNonEmptyString(value.urlPattern, `${field}.urlPattern`);
    if (urlPattern) {
        try {new RegExp(urlPattern);}
        catch {throw invalidArtifact(`${field}.urlPattern must be a valid regular expression`);}
    }
    return {kind: value.kind as EntityRulePageKind, urlPattern};
};

const assertLegacyPageKindPreserved = (
    rules: readonly EntityRuleMatchRecord[],
    pageKind: EntityRulePageKind,
): void => {
    const explicitDomains = new Set(rules
        .map((rule) => rule.match.kind)
        .filter((kind): kind is EntityRulePageKind => ENTITY_RULE_PAGE_KINDS.has(kind as EntityRulePageKind)));
    if (explicitDomains.size > 0 && (explicitDomains.size !== 1 || !explicitDomains.has(pageKind))) {
        throw invalidArtifact(`legacy import cannot preserve ${pageKind} page kind with contradictory rule domains`);
    }
};

const assertAcyclicDependencies = (rules: readonly EntityRuleMatchRecord[]): void => {
    const dependenciesByRuleId = new Map(rules.map((rule) => [
        rule.ruleId,
        [rule.within, rule.contains].filter((value): value is string => Boolean(value)),
    ]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (ruleId: string, path: string[]): void => {
        if (visiting.has(ruleId)) {
            const start = path.indexOf(ruleId);
            throw invalidArtifact(`rule dependency cycle detected: ${[...path.slice(Math.max(0, start)), ruleId].join(' -> ')}`);
        }
        if (visited.has(ruleId)) {return;}
        visiting.add(ruleId);
        for (const dependency of dependenciesByRuleId.get(ruleId) ?? []) {
            visit(dependency, [...path, ruleId]);
        }
        visiting.delete(ruleId);
        visited.add(ruleId);
    };
    for (const rule of rules) {visit(rule.ruleId, []);}
};

const requireProfileName = (value: unknown): string => {
    const name = requireNonEmptyString(value, 'profile name');
    try {
        return requireArtifactName(name, 'entity-rule profile name');
    } catch {
        throw invalidArtifact(`invalid profile name: ${name}`);
    }
};

const requireNonEmptyString = (value: unknown, field: string): string => {
    if (typeof value !== 'string' || !value.trim()) {
        throw invalidArtifact(`${field} must be a non-empty string`);
    }
    return value.trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const invalidArtifact = (message: string): DslRuntimeError => new DslRuntimeError(
    `invalid Snapshot V2 entity_rules artifact: ${message}`,
    'ERR_ENTITY_RULES_INVALID',
);
