import fs from 'node:fs';
import path from 'node:path';
import { readTextFile, removePath, workflowRootDir, writeTextFile } from './fs';
import type { WorkflowCodec } from './store';

export type WorkflowDsl = {
    kind: 'dsl';
    name: string;
    content: string;
    updatedAt?: number;
};

const dslPath = (workflowName: string, dslName: string): string =>
    path.join(workflowRootDir(workflowName), 'dsls', `${dslName}.dsl`);

export const createDslCodec = (workflowName: string): WorkflowCodec<WorkflowDsl> => ({
    kind: 'dsl',
    is: (value: unknown): value is WorkflowDsl => {
        const rec = value as Partial<WorkflowDsl>;
        return !!rec && rec.kind === 'dsl' && typeof rec.name === 'string' && !!rec.name && typeof rec.content === 'string';
    },
    load: (name) => {
        try {
            const content = readTextFile(dslPath(workflowName, name));
            return { kind: 'dsl', name, content };
        } catch {
            return null;
        }
    },
    list: () => {
        const dir = path.join(workflowRootDir(workflowName), 'dsls');
        try {
            return fs
                .readdirSync(dir, { withFileTypes: true })
                .filter((entry) => entry.isFile() && entry.name.endsWith('.dsl'))
                .map((entry) => ({ kind: 'dsl', name: entry.name.slice(0, -4), content: readTextFile(path.join(dir, entry.name)) }));
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
