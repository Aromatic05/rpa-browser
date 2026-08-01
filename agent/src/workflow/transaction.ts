import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {WorkflowArtifactKind} from './workflow';
import {ensureDir, removePath, requireArtifactName, workflowArtifactPath} from './fs';

export type WorkflowArtifactSnapshot = {
    root: string;
    entries: Array<{target: string; backup: string; existed: boolean}>;
};

const artifactStoragePaths = (
    workflowName: string,
    kind: WorkflowArtifactKind,
    name: string,
): string[] => {
    const artifactName = requireArtifactName(name, `${kind} artifact name`);
    if (kind === 'dsl') {
        return [
            workflowArtifactPath(workflowName, 'dsls', `${artifactName}.dsl`),
            workflowArtifactPath(workflowName, 'dsls', `${artifactName}.resolve.yaml`),
        ];
    }
    const directory = kind === 'entity_rules' ? 'entity_rules' : `${kind}s`;
    return [workflowArtifactPath(workflowName, directory, artifactName)];
};

export const snapshotWorkflowArtifact = (
    workflowName: string,
    kind: WorkflowArtifactKind,
    name: string,
): WorkflowArtifactSnapshot => {
    const root = workflowArtifactPath(workflowName, '.transactions', crypto.randomUUID());
    const entries = artifactStoragePaths(workflowName, kind, name).map((target, index) => {
        const backup = path.join(root, String(index));
        const existed = fs.existsSync(target);
        if (existed) {
            ensureDir(path.dirname(backup));
            fs.cpSync(target, backup, {recursive: true});
        }
        return {target, backup, existed};
    });
    return {root, entries};
};

export const restoreWorkflowArtifact = (snapshot: WorkflowArtifactSnapshot): void => {
    for (const entry of snapshot.entries) {
        removePath(entry.target);
        if (!entry.existed) {continue;}
        ensureDir(path.dirname(entry.target));
        fs.cpSync(entry.backup, entry.target, {recursive: true});
    }
    removePath(snapshot.root);
};

export const discardWorkflowArtifactSnapshot = (snapshot: WorkflowArtifactSnapshot): void => {
    removePath(snapshot.root);
};
