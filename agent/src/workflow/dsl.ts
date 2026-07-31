import fs from 'node:fs';
import path from 'node:path';
import { readTextFile, removePath, requireArtifactName, workflowArtifactPath, workflowRootDir, writeTextFile } from './fs';
import type { WorkflowCodec } from './store';

export type WorkflowDsl = {
    kind: 'dsl';
    name: string;
    content: string;
    updatedAt?: number;
};

const dslPath = (workflowName: string, dslName: string): string =>
    workflowArtifactPath(workflowName, 'dsls', `${requireArtifactName(dslName, 'DSL name')}.dsl`);

export const createDslCodec = (workflowName: string): WorkflowCodec<WorkflowDsl> => ({
    kind: 'dsl',
    is: (value: unknown): value is WorkflowDsl =>
        isRecord(value) && value.kind === 'dsl' && typeof value.name === 'string'
        && isArtifactName(value.name) && typeof value.content === 'string',
    load: (name) => {
        try {
            const content = readTextFile(dslPath(workflowName, name));
            return { kind: 'dsl', name, content };
        } catch {
            return null;
        }
    },
    list: () => {
        const dir = workflowArtifactPath(workflowName, 'dsls');
        try {
            return fs
                .readdirSync(dir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith('.dsl'))
                .map((entry) => entry.name.slice(0, -4))
                .filter(isArtifactName)
                .map((name) => ({ kind: 'dsl' as const, name, content: readTextFile(dslPath(workflowName, name)) }));
        } catch {
            return [];
        }
    },
    save: (value) => {
        writeTextFile(dslPath(workflowName, value.name), value.content);
        return value;
    },
    delete: (name) => {
        removePath(dslPath(workflowName, name));
        return true;
    },
});

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
