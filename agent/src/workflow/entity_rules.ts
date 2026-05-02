import path from 'node:path';
import { validateEntityRules } from '../runner/steps/executors/snapshot/entity_rules/validate';
import type { NormalizedEntityRuleBundle } from '../runner/steps/executors/snapshot/entity_rules/types';
import { listDirectories, readYamlFile, removePath, workflowRootDir, writeYamlFile } from './fs';
import type { WorkflowCodec } from './store';

export type WorkflowEntityRules = {
    kind: 'entity-rules';
    name: string;
    match: unknown;
    annotation: unknown;
};

const entityRuleDir = (workflowName: string, profileName: string): string =>
    path.join(workflowRootDir(workflowName), 'entity_rules', profileName);

export const createEntityRulesCodec = (workflowName: string): WorkflowCodec<WorkflowEntityRules> => ({
    kind: 'entity-rules',
    is: (value: unknown): value is WorkflowEntityRules => {
        const rec = value as Partial<WorkflowEntityRules>;
        return !!rec && rec.kind === 'entity-rules' && typeof rec.name === 'string' && !!rec.name;
    },
    load: (name) => {
        const dir = entityRuleDir(workflowName, name);
        try {
            const match = readYamlFile<unknown>(path.join(dir, 'match.yaml'));
            const annotation = readYamlFile<unknown>(path.join(dir, 'annotation.yaml'));
            validateEntityRules(name, match, annotation);
            return { kind: 'entity-rules', name, match, annotation };
        } catch {
            return null;
        }
    },
    list: () =>
        listDirectories(path.join(workflowRootDir(workflowName), 'entity_rules'))
            .map((name) => createEntityRulesCodec(workflowName).load(name))
            .filter((item): item is WorkflowEntityRules => item !== null),
    save: (value) => {
        const validated = validateEntityRules(value.name, value.match, value.annotation);
        if (!validated.ok) {
            throw new Error(validated.errors.join('; '));
        }
        const dir = entityRuleDir(workflowName, value.name);
        writeYamlFile(path.join(dir, 'match.yaml'), value.match);
        writeYamlFile(path.join(dir, 'annotation.yaml'), value.annotation);
        return value;
    },
    delete: (name) => {
        removePath(entityRuleDir(workflowName, name));
        return true;
    },
});

export const toEntityRuleBundle = (value: WorkflowEntityRules): NormalizedEntityRuleBundle => {
    const validated = validateEntityRules(value.name, value.match, value.annotation);
    if (!validated.ok) {
        throw new Error(validated.errors.join('; '));
    }
    return validated.bundle;
};
