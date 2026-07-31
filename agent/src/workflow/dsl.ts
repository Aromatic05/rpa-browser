import fs from 'node:fs';
import path from 'node:path';
import type { StepResolve } from '../runner/steps/types';
import type { StepResolveFile } from '../runner/serialization/types';
import { validateStepResolveFileForSerialization } from '../runner/serialization/types';
import { readTextFile, readValidatedYamlFile, removePath, requireArtifactName, workflowArtifactPath, writeTextFile, writeYamlFile } from './fs';
import { invalidWorkflowArtifact } from './errors';
import type { WorkflowCodec } from './store';

export type WorkflowDsl = {
    kind: 'dsl';
    name: string;
    content: string;
    stepResolves: Record<string, StepResolve>;
    updatedAt?: number;
};

const dslPath = (workflowName: string, dslName: string): string =>
    workflowArtifactPath(workflowName, 'dsls', `${requireArtifactName(dslName, 'DSL name')}.dsl`);

const dslResolvePath = (workflowName: string, dslName: string): string =>
    workflowArtifactPath(workflowName, 'dsls', `${requireArtifactName(dslName, 'DSL name')}.resolve.yaml`);

export const createDslCodec = (workflowName: string): WorkflowCodec<WorkflowDsl> => ({
    kind: 'dsl',
    is: (value: unknown): value is WorkflowDsl =>
        isRecord(value) && value.kind === 'dsl' && typeof value.name === 'string'
        && isArtifactName(value.name) && typeof value.content === 'string'
        && isRecord(value.stepResolves),
    load: (name) => {
        try {
            const content = readTextFile(dslPath(workflowName, name));
            const resolveFile = readOptionalResolveFile(dslResolvePath(workflowName, name));
            return { kind: 'dsl', name, content, stepResolves: resolveFile?.resolves ?? {} };
        } catch (error) {
            if (isMissingFile(error)) {return null;}
            throw invalidWorkflowArtifact('dsl', name, error);
        }
    },
    list: () => {
        const dir = workflowArtifactPath(workflowName, 'dsls');
        let names: string[];
        try {
            names = fs
                .readdirSync(dir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith('.dsl'))
                .map((entry) => entry.name.slice(0, -4))
                .filter(isArtifactName);
        } catch {
            return [];
        }
        return names
            .map((name) => createDslCodec(workflowName).load(name))
            .filter((item): item is WorkflowDsl => item !== null);
    },
    save: (value) => {
        const resolveFile: StepResolveFile = {version: 1, resolves: value.stepResolves};
        validateStepResolveFileForSerialization(resolveFile);
        writeTextFile(dslPath(workflowName, value.name), value.content);
        writeYamlFile(dslResolvePath(workflowName, value.name), resolveFile);
        return value;
    },
    delete: (name) => {
        removePath(dslPath(workflowName, name));
        removePath(dslResolvePath(workflowName, name));
        return true;
    },
});

const readOptionalResolveFile = (filePath: string): StepResolveFile | null => {
    try {
        return readValidatedYamlFile<StepResolveFile>(filePath, validateStepResolveFileForSerialization);
    } catch (error) {
        if (isMissingFile(error)) {return null;}
        throw error;
    }
};

const isMissingFile = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isArtifactName = (name: string): boolean => {
    try {
        requireArtifactName(name, 'DSL name');
        return true;
    } catch {
        return false;
    }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
