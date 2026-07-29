import path from 'node:path';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import {
    listDirectories,
    readYamlFile,
    removePath,
    workflowRootDir,
    writeYamlFile,
} from './fs';
import type { WorkflowCodec } from './store';

export type EntityRuleMatchRecord = {
    ruleId: string;
    source: 'region' | 'group' | 'node';
    expect: 'unique' | 'one_or_more';
    within?: string;
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
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
};

export type EntityRuleBundle = {
    id: string;
    match: EntityRuleMatchArtifact;
    annotation: EntityRuleAnnotationArtifact;
};

const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const entityRuleDirectory = (workflowName: string, profileName: string): string =>
    path.join(workflowRootDir(workflowName), 'entity_rules', profileName);

export const validateWorkflowEntityRules = (value: unknown): WorkflowEntityRules => {
    if (!isRecord(value) || value.kind !== 'entity_rules') {
        throw invalidArtifact('artifact kind must be entity_rules');
    }
    const name = requireProfileName(value.name);
    const match = validateMatchArtifact(value.match);
    const annotation = validateAnnotationArtifact(value.annotation, new Set(match.rules.map((rule) => rule.ruleId)));
    return {
        kind: 'entity_rules',
        name,
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
    const matchPageKind = requireLegacyPageKind(value.match.page, 'match.page');
    const annotationPageKind = requireLegacyPageKind(value.annotation.page, 'annotation.page');
    if (matchPageKind !== annotationPageKind) {
        throw invalidArtifact(`legacy page kind mismatch: ${matchPageKind} != ${annotationPageKind}`);
    }
    const name = requireProfileName(value.name);
    const match = validateMatchArtifact({version: 2, rules: value.match.entities});
    assertLegacyPageKindPreserved(match.rules, matchPageKind);
    const annotation = validateAnnotationArtifact(
        {version: 2, bindings: value.annotation.annotations},
        new Set(match.rules.map((rule) => rule.ruleId)),
    );
    return {kind: 'entity_rules', name, match, annotation};
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
            return importWorkflowEntityRules({
                kind: 'entity_rules',
                name: profileName,
                match: readYamlFile(path.join(directory, 'match.yaml')),
                annotation: readYamlFile(path.join(directory, 'annotation.yaml')),
            });
        } catch {
            return null;
        }
    },
    list: () => listDirectories(path.join(workflowRootDir(workflowName), 'entity_rules'))
        .map((name) => createEntityRulesCodec(workflowName).load(name))
        .filter((value): value is WorkflowEntityRules => value !== null),
    save: (value) => {
        const validated = validateWorkflowEntityRules(value);
        const directory = entityRuleDirectory(workflowName, validated.name);
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
        match: structuredClone(validated.match),
        annotation: structuredClone(validated.annotation),
    };
};

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
    }
    assertAcyclicWithin(rules);
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
    return {
        ruleId,
        source: value.source,
        expect: value.expect,
        within,
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

const requireLegacyPageKind = (value: unknown, field: string): 'form' | 'table' => {
    if (!isRecord(value) || (value.kind !== 'form' && value.kind !== 'table')) {
        throw invalidArtifact(`${field}.kind must be form or table`);
    }
    return value.kind;
};

const assertLegacyPageKindPreserved = (
    rules: readonly EntityRuleMatchRecord[],
    pageKind: 'form' | 'table',
): void => {
    const explicitDomains = new Set(rules
        .map((rule) => rule.match.kind)
        .filter((kind): kind is 'form' | 'table' => kind === 'form' || kind === 'table'));
    if (explicitDomains.size !== 1 || !explicitDomains.has(pageKind)) {
        throw invalidArtifact(`legacy import cannot preserve ${pageKind} page kind without a matching V2 root rule`);
    }
};

const assertAcyclicWithin = (rules: readonly EntityRuleMatchRecord[]): void => {
    const parentByRuleId = new Map(rules.filter((rule) => rule.within).map((rule) => [rule.ruleId, rule.within!]));
    const visited = new Set<string>();
    const visiting = new Set<string>();
    const visit = (ruleId: string, path: string[]): void => {
        if (visiting.has(ruleId)) {
            const start = path.indexOf(ruleId);
            throw invalidArtifact(`within cycle detected: ${[...path.slice(Math.max(0, start)), ruleId].join(' -> ')}`);
        }
        if (visited.has(ruleId)) {return;}
        visiting.add(ruleId);
        const parent = parentByRuleId.get(ruleId);
        if (parent) {visit(parent, [...path, ruleId]);}
        visiting.delete(ruleId);
        visited.add(ruleId);
    };
    for (const rule of rules) {visit(rule.ruleId, []);}
};

const requireProfileName = (value: unknown): string => {
    const name = requireNonEmptyString(value, 'profile name');
    if (!PROFILE_NAME_PATTERN.test(name)) {
        throw invalidArtifact(`invalid profile name: ${name}`);
    }
    return name;
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
