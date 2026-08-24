import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {WorkflowArtifactKind} from './workflow';
import {ensureDir, removePath, requireArtifactName, workflowArtifactPath, workflowsRootDir} from './fs';
import {WorkflowError} from './errors';
import {
    observeStaleDirectoryLockSync,
    readDirectoryLockOwnerSync,
    reclaimObservedDirectoryLockSync,
} from '../../storage/directory_lock';

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

type WorkflowLockOwner = {
    pid: number;
    acquiredAt: number;
    token: string;
};

const LOCK_WAIT_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 10;
const LOCK_STALE_MS = 5 * 60_000;
const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const heldWorkflowLocks = new Set<string>();

const sleepSync = (durationMs: number): void => {
    Atomics.wait(sleepArray, 0, 0, durationMs);
};

const workflowLockDir = (workflowName: string): string => path.join(
    workflowsRootDir(),
    '.locks',
    `${requireArtifactName(workflowName, 'workflow name')}.lock`,
);

const acquireWorkflowMutationLock = (workflowName: string): (() => void) => {
    const lockDir = workflowLockDir(workflowName);
    if (heldWorkflowLocks.has(lockDir)) {
        throw new WorkflowError(
            `workflow mutation already active in this process: ${workflowName}`,
            'ERR_WORKFLOW_CONFLICT',
        );
    }
    const owner: WorkflowLockOwner = {
        pid: process.pid,
        acquiredAt: Date.now(),
        token: crypto.randomUUID(),
    };
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    ensureDir(path.dirname(lockDir));

    while (true) {
        try {
            fs.mkdirSync(lockDir);
            try {
                fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
            } catch (error) {
                fs.rmSync(lockDir, {recursive: true, force: true});
                throw error;
            }
            heldWorkflowLocks.add(lockDir);
            break;
        } catch (error) {
            const isExisting = typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
            if (!isExisting) {throw error;}
            if (readDirectoryLockOwnerSync(lockDir)?.pid === process.pid) {
                throw new WorkflowError(
                    `workflow mutation already active in this process: ${workflowName}`,
                    'ERR_WORKFLOW_CONFLICT',
                );
            }
            const staleObservation = observeStaleDirectoryLockSync(lockDir, LOCK_STALE_MS);
            if (staleObservation && reclaimObservedDirectoryLockSync(lockDir, staleObservation)) {continue;}
            if (Date.now() >= deadline) {
                throw new WorkflowError(
                    `workflow mutation lock timeout: ${workflowName}`,
                    'ERR_WORKFLOW_CONFLICT',
                );
            }
            sleepSync(LOCK_RETRY_MS);
        }
    }

    let released = false;
    return () => {
        if (released) {return;}
        released = true;
        try {
            const currentOwner = readDirectoryLockOwnerSync(lockDir);
            if (currentOwner?.token === owner.token) {
                fs.rmSync(lockDir, {recursive: true, force: true});
            }
        } finally {
            heldWorkflowLocks.delete(lockDir);
        }
    };
};

const normalizeWorkflowNames = (workflowNames: string[]): string[] =>
    [...new Set(workflowNames.map((name) => requireArtifactName(name, 'workflow name')))].sort();

export const withWorkflowMutationLock = <T>(workflowName: string, operation: () => T): T => {
    const release = acquireWorkflowMutationLock(workflowName);
    try {
        return operation();
    } finally {
        release();
    }
};

export const withWorkflowMutationLocks = <T>(workflowNames: string[], operation: () => T): T => {
    const releases: Array<() => void> = [];
    try {
        for (const name of normalizeWorkflowNames(workflowNames)) {
            releases.push(acquireWorkflowMutationLock(name));
        }
        return operation();
    } finally {
        for (const release of releases.reverse()) {release();}
    }
};

export const withWorkflowMutationLocksAsync = async <T>(
    workflowNames: string[],
    operation: () => Promise<T>,
): Promise<T> => {
    const releases: Array<() => void> = [];
    try {
        for (const name of normalizeWorkflowNames(workflowNames)) {
            releases.push(acquireWorkflowMutationLock(name));
        }
        return await operation();
    } finally {
        for (const release of releases.reverse()) {release();}
    }
};
