import path from 'node:path';
import fs from 'node:fs';
import { WorkflowError } from './errors';
import { createCheckpointCodec, type WorkflowCheckpoint } from './checkpoint';
import { createDslCodec, type WorkflowDsl } from './dsl';
import { ensureDir, existsDir, listDirectories, readYamlFile, removePath, requireArtifactName, workflowManifestPath, workflowRootDir, workflowsRootDir, writeYamlFile } from './fs';
import { createRecordingCodec, type WorkflowRecording } from './recording';
import { createEntityRulesCodec, type WorkflowEntityRules } from './entity_rules';
import { createNamedStore, type NamedStore } from './store';
import {
    discardWorkflowArtifactSnapshot,
    restoreWorkflowArtifact,
    snapshotWorkflowArtifact,
    withWorkflowMutationLock,
    withWorkflowMutationLocks,
    withWorkflowMutationLocksAsync,
} from './transaction';

export type WorkflowArtifactKind = 'recording' | 'checkpoint' | 'dsl' | 'entity_rules';
export type WorkflowDummy = { kind: WorkflowArtifactKind };

const WORKFLOW_ARTIFACT_KINDS = new Set<WorkflowArtifactKind>([
    'recording',
    'checkpoint',
    'dsl',
    'entity_rules',
]);

export type WorkflowArtifact = WorkflowRecording | WorkflowCheckpoint | WorkflowDsl | WorkflowEntityRules;

export type WorkflowCatalogItemBase = {
    kind: WorkflowArtifactKind;
    name: string;
    title: string;
    createdAt: number;
    updatedAt: number;
    summary: string;
};

export type WorkflowCheckpointCatalogItem = WorkflowCatalogItemBase & {
    kind: 'checkpoint';
    enabled?: boolean;
    priority?: number;
};

export type WorkflowCatalogItem =
    | (WorkflowCatalogItemBase & { kind: 'recording' })
    | WorkflowCheckpointCatalogItem
    | (WorkflowCatalogItemBase & { kind: 'dsl' })
    | (WorkflowCatalogItemBase & { kind: 'entity_rules'; enabled?: boolean });

export type WorkflowManifest = {
    version: 1;
    name: string;
    entry: { dsl: string };
    createdAt: number;
    updatedAt: number;
    catalog: WorkflowCatalogItem[];
};

export type Workflow = {
    readonly name: string;
    entryDslName?: () => string;
    save: (value: WorkflowArtifact) => WorkflowArtifact;
    get: (name: string, dummy: WorkflowDummy) => WorkflowArtifact | null;
    list: (dummy: WorkflowDummy) => WorkflowCatalogItem[];
    delete: (name: string, dummy: WorkflowDummy) => boolean;
};

type WorkflowInternal = {
    recordingStore: NamedStore<WorkflowRecording>;
    checkpointStore: NamedStore<WorkflowCheckpoint>;
    dslStore: NamedStore<WorkflowDsl>;
    entityRulesStore: NamedStore<WorkflowEntityRules>;
};

const defaultManifest = (name: string, now = Date.now()): WorkflowManifest => ({
    version: 1,
    name,
    entry: { dsl: 'main' },
    createdAt: now,
    updatedAt: now,
    catalog: [],
});

const readManifest = (workflowName: string): WorkflowManifest => {
    const filePath = workflowManifestPath(workflowName);
    const parsed = readYamlFile(filePath);
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.name !== 'string') {
        throw new WorkflowError(`invalid workflow manifest: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    if (!isRecord(parsed.entry) || typeof parsed.entry.dsl !== 'string') {
        throw new WorkflowError(`invalid workflow manifest entry: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    return parseWorkflowManifest(parsed, workflowName);
};

const writeManifest = (manifest: WorkflowManifest): WorkflowManifest => {
    const persisted = {...manifest, updatedAt: Date.now()};
    writeYamlFile(workflowManifestPath(persisted.name), persisted);
    return persisted;
};

const createInternal = (workflowName: string): WorkflowInternal => {
    const recordingStore = createNamedStore(createRecordingCodec(workflowName));
    const checkpointStore = createNamedStore(createCheckpointCodec(workflowName));
    const dslStore = createNamedStore(createDslCodec(workflowName));
    const entityRulesStore = createNamedStore(createEntityRulesCodec(workflowName));
    return { recordingStore, checkpointStore, dslStore, entityRulesStore };
};

const toCatalogItem = (artifact: WorkflowArtifact, existing?: WorkflowCatalogItem): WorkflowCatalogItem => {
    const now = Date.now();
    const base: WorkflowCatalogItemBase = {
        kind: artifact.kind,
        name: artifact.name,
        title: existing?.title || artifact.name,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
        summary: artifact.kind,
    };
    if (artifact.kind === 'checkpoint') {
        return {
            ...base,
            kind: 'checkpoint',
            enabled: artifact.checkpoint.enabled,
            priority: artifact.checkpoint.priority,
        };
    }
    if (artifact.kind === 'entity_rules') {
        return {
            ...base,
            kind: 'entity_rules',
            enabled: true,
            summary: `rules=${artifact.match.rules.length}, bindings=${artifact.annotation.bindings.length}`,
        };
    }
    if (artifact.kind === 'recording') {
        return { ...base, kind: 'recording', summary: `steps=${artifact.steps.length}` };
    }
    return { ...base, kind: 'dsl', summary: `bytes=${artifact.content.length}` };
};

const saveArtifact = (internal: WorkflowInternal, value: WorkflowArtifact): WorkflowArtifact => {
    switch (value.kind) {
        case 'recording': return internal.recordingStore.save(value);
        case 'checkpoint': return internal.checkpointStore.save(value);
        case 'dsl': return internal.dslStore.save(value);
        case 'entity_rules': return internal.entityRulesStore.save(value);
    }
};

const resolveStore = (internal: WorkflowInternal, kind: WorkflowArtifactKind): NamedStore<WorkflowArtifact> => {
    if (kind === 'recording') {
        return internal.recordingStore as NamedStore<WorkflowArtifact>;
    }
    if (kind === 'checkpoint') {
        return internal.checkpointStore as NamedStore<WorkflowArtifact>;
    }
    if (kind === 'dsl') {
        return internal.dslStore as NamedStore<WorkflowArtifact>;
    }
    return internal.entityRulesStore as NamedStore<WorkflowArtifact>;
};

const toCatalogViewItem = (
    artifact: WorkflowArtifact,
    existing?: WorkflowCatalogItem,
): WorkflowCatalogItem => {
    const derived = toCatalogItem(artifact, existing);
    if (!existing) {return derived;}
    return {
        ...derived,
        title: existing.title,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
    };
};

const validateStoredArtifacts = (workflowName: string): void => {
    const internal = createInternal(workflowName);
    for (const kind of WORKFLOW_ARTIFACT_KINDS) {
        resolveStore(internal, kind).list();
    }
};

const reconcileCatalog = (
    internal: WorkflowInternal,
    manifest: WorkflowManifest,
    updated?: WorkflowArtifact,
): WorkflowCatalogItem[] => {
    const catalog: WorkflowCatalogItem[] = [];
    let updatedPrevious: WorkflowCatalogItem | undefined;
    for (const item of manifest.catalog) {
        if (updated?.kind === item.kind && updated.name === item.name) {
            updatedPrevious = item;
            continue;
        }
        try {
            const artifact = resolveStore(internal, item.kind).get(item.name);
            if (artifact) {catalog.push(toCatalogViewItem(artifact, item));}
        } catch {
            // Catalog is cache metadata. Keep an entry for a corrupt stored artifact so an
            // unrelated mutation does not have to repair every broken artifact first.
            catalog.push(item);
        }
    }
    if (updated) {catalog.push(toCatalogItem(updated, updatedPrevious));}
    return catalog.sort((left, right) =>
        left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name));
};

const loadWorkflowUnlocked = (workflowName: string): Workflow => {
    if (!existsDir(workflowRootDir(workflowName))) {
        throw new WorkflowError(`workflow not found: ${workflowName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    let manifest = readManifest(workflowName);
    const internal = createInternal(workflowName);
    const refreshManifest = (): WorkflowManifest => {
        manifest = readManifest(workflowName);
        return manifest;
    };

    return {
        name: workflowName,
        entryDslName: () => withWorkflowMutationLock(
            workflowName,
            () => refreshManifest().entry.dsl,
        ),
        save: (value) => withWorkflowMutationLock(workflowName, () => {
            const currentManifest = refreshManifest();
            const snapshot = snapshotWorkflowArtifact(workflowName, value.kind, value.name);
            let saved: WorkflowArtifact;
            try {
                saved = saveArtifact(internal, value);
                const nextManifest = structuredClone(currentManifest);
                nextManifest.catalog = reconcileCatalog(internal, currentManifest, saved);
                manifest = writeManifest(nextManifest);
            } catch (error) {
                try {
                    restoreWorkflowArtifact(snapshot);
                } catch (rollbackError) {
                    throw new WorkflowError(
                        `workflow save rollback failed: ${value.kind}:${value.name}`,
                        'ERR_WORKFLOW_TRANSACTION_FAILED',
                        rollbackError instanceof Error ? {cause: rollbackError} : undefined,
                    );
                }
                throw error;
            }
            discardWorkflowArtifactSnapshot(snapshot);
            return saved;
        }),
        get: (name, dummy) => withWorkflowMutationLock(workflowName, () => {
            requireArtifactName(name, `${dummy.kind} artifact name`);
            refreshManifest();
            return resolveStore(internal, dummy.kind).get(name);
        }),
        list: (dummy) => withWorkflowMutationLock(
            workflowName,
            () => {
                const currentManifest = refreshManifest();
                const existing = new Map(
                    currentManifest.catalog
                        .filter((item) => item.kind === dummy.kind)
                        .map((item) => [item.name, item]),
                );
                return resolveStore(internal, dummy.kind).list()
                    .map((artifact) => toCatalogViewItem(artifact, existing.get(artifact.name)));
            },
        ),
        delete: (name, dummy) => withWorkflowMutationLock(workflowName, () => {
            requireArtifactName(name, `${dummy.kind} artifact name`);
            const currentManifest = refreshManifest();
            if (dummy.kind === 'dsl' && name === currentManifest.entry.dsl) {
                throw new WorkflowError(`cannot delete workflow entry DSL: ${name}`, 'ERR_WORKFLOW_BAD_ARGS');
            }
            const snapshot = snapshotWorkflowArtifact(workflowName, dummy.kind, name);
            let deleted: boolean;
            try {
                deleted = resolveStore(internal, dummy.kind).delete(name);
                const nextManifest = structuredClone(currentManifest);
                nextManifest.catalog = reconcileCatalog(internal, currentManifest);
                manifest = writeManifest(nextManifest);
            } catch (error) {
                try {
                    restoreWorkflowArtifact(snapshot);
                } catch (rollbackError) {
                    throw new WorkflowError(
                        `workflow delete rollback failed: ${dummy.kind}:${name}`,
                        'ERR_WORKFLOW_TRANSACTION_FAILED',
                        rollbackError instanceof Error ? {cause: rollbackError} : undefined,
                    );
                }
                throw error;
            }
            discardWorkflowArtifactSnapshot(snapshot);
            return deleted;
        }),
    };
};

export const loadWorkflowFromFs = (workflowName: string): Workflow =>
    withWorkflowMutationLock(workflowName, () => loadWorkflowUnlocked(workflowName));

const createWorkflowUnlocked = (workflowName: string): Workflow => {
    const rootDir = workflowRootDir(workflowName);
    if (fs.existsSync(rootDir)) {
        throw new WorkflowError(`workflow already exists: ${workflowName}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    try {
        ensureDir(path.join(rootDir, 'recordings'));
        ensureDir(path.join(rootDir, 'checkpoints'));
        ensureDir(path.join(rootDir, 'dsls'));
        ensureDir(path.join(rootDir, 'entity_rules'));
        const manifest = defaultManifest(workflowName);
        writeYamlFile(workflowManifestPath(workflowName), manifest);
        return loadWorkflowUnlocked(workflowName);
    } catch (error) {
        removePath(rootDir);
        throw error;
    }
};

export const createWorkflowOnFs = (workflowName: string): Workflow => {
    return withWorkflowMutationLock(workflowName, () => createWorkflowUnlocked(workflowName));
};

export const ensureWorkflowOnFs = (workflowName: string): Workflow => {
    return withWorkflowMutationLock(workflowName, () => {
        if (fs.existsSync(workflowRootDir(workflowName))) {
            return loadWorkflowUnlocked(workflowName);
        }
        return createWorkflowUnlocked(workflowName);
    });
};

const requireWorkflowRenameManifest = (fromName: string, toName: string): WorkflowManifest => {
    const fromDir = workflowRootDir(fromName);
    const toDir = workflowRootDir(toName);
    if (!existsDir(fromDir)) {
        throw new WorkflowError(`workflow not found: ${fromName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    if (fs.existsSync(toDir)) {
        throw new WorkflowError(`workflow already exists: ${toName}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    const manifest = readManifest(fromName);
    validateStoredArtifacts(fromName);
    return manifest;
};

export const validateWorkflowRenameOnFs = (fromName: string, toName: string): void => {
    withWorkflowMutationLocks([fromName, toName], () => {
        requireWorkflowRenameManifest(fromName, toName);
    });
};

const renameWorkflowUnlocked = (
    fromName: string,
    toName: string,
    manifest: WorkflowManifest,
): void => {
    const fromDir = workflowRootDir(fromName);
    const toDir = workflowRootDir(toName);
    fs.renameSync(fromDir, toDir);
    try {
        writeYamlFile(workflowManifestPath(toName), {
            ...manifest,
            name: toName,
            updatedAt: Date.now(),
        } satisfies WorkflowManifest);
    } catch (error) {
        try {
            fs.renameSync(toDir, fromDir);
        } catch (rollbackError) {
            throw new WorkflowError(
                `workflow rename rollback failed: ${fromName} -> ${toName}`,
                'ERR_WORKFLOW_TRANSACTION_FAILED',
                rollbackError instanceof Error ? {cause: rollbackError} : undefined,
            );
        }
        throw error;
    }
};

export const renameWorkflowOnFs = (fromName: string, toName: string): void => {
    withWorkflowMutationLocks([fromName, toName], () => {
        renameWorkflowUnlocked(fromName, toName, requireWorkflowRenameManifest(fromName, toName));
    });
};

export const renameWorkflowAfterPreparationOnFs = async (
    fromName: string,
    toName: string,
    prepare: () => Promise<void>,
): Promise<void> => {
    await withWorkflowMutationLocksAsync([fromName, toName], async () => {
        const manifest = requireWorkflowRenameManifest(fromName, toName);
        await prepare();
        renameWorkflowUnlocked(fromName, toName, manifest);
    });
};

export const copyWorkflowOnFs = (sourceName: string, targetName: string): void => {
    withWorkflowMutationLocks([sourceName, targetName], () => {
        const sourceDir = workflowRootDir(sourceName);
        const targetDir = workflowRootDir(targetName);
        if (!existsDir(sourceDir)) {
            throw new WorkflowError(`workflow not found: ${sourceName}`, 'ERR_WORKFLOW_NOT_FOUND');
        }
        if (fs.existsSync(targetDir)) {
            throw new WorkflowError(`workflow already exists: ${targetName}`, 'ERR_WORKFLOW_BAD_ARGS');
        }
        const manifest = readManifest(sourceName);
        validateStoredArtifacts(sourceName);
        try {
            fs.cpSync(sourceDir, targetDir, { recursive: true });
            writeYamlFile(workflowManifestPath(targetName), {
                ...manifest,
                name: targetName,
                updatedAt: Date.now(),
            } satisfies WorkflowManifest);
        } catch (error) {
            removePath(targetDir);
            throw error;
        }
    });
};

export const listWorkflowNames = (): string[] => listDirectories(workflowsRootDir()).filter((name) => {
    try {
        requireArtifactName(name, 'workflow name');
        return true;
    } catch {
        return false;
    }
});
export const deleteWorkflowFromFs = (workflowName: string): void => {
    withWorkflowMutationLock(workflowName, () => {
        removePath(workflowRootDir(workflowName));
    });
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseWorkflowManifest = (value: unknown, workflowName: string): WorkflowManifest => {
    if (!isRecord(value) || value.version !== 1 || typeof value.name !== 'string'
        || !isRecord(value.entry) || typeof value.entry.dsl !== 'string'
        || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
        throw new WorkflowError(
            `invalid workflow manifest: ${workflowName}`,
            'ERR_WORKFLOW_INVALID_MANIFEST',
        );
    }
    requireArtifactName(value.name, 'workflow name');
    if (value.name !== workflowName) {
        throw new WorkflowError(
            `workflow manifest identity mismatch: directory=${workflowName} manifest=${value.name}`,
            'ERR_WORKFLOW_INVALID_MANIFEST',
        );
    }
    requireArtifactName(value.entry.dsl, 'workflow entry DSL name');
    return {
        ...value,
        version: 1,
        name: value.name,
        entry: {...value.entry, dsl: value.entry.dsl},
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        catalog: parseCatalogCache(value.catalog),
    } as WorkflowManifest;
};

const parseCatalogCache = (value: unknown): WorkflowCatalogItem[] => {
    if (!Array.isArray(value)) {return [];}
    const catalog: WorkflowCatalogItem[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (!isRecord(item) || typeof item.kind !== 'string'
            || !WORKFLOW_ARTIFACT_KINDS.has(item.kind as WorkflowArtifactKind)
            || typeof item.name !== 'string') {continue;}
        try {
            requireArtifactName(item.name, `${item.kind} artifact name`);
        } catch {
            continue;
        }
        const kind = item.kind as WorkflowArtifactKind;
        const key = `${kind}:${item.name}`;
        if (seen.has(key)) {continue;}
        seen.add(key);
        const base: WorkflowCatalogItemBase = {
            kind,
            name: item.name,
            title: typeof item.title === 'string' && item.title ? item.title : item.name,
            createdAt: typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0,
            updatedAt: typeof item.updatedAt === 'number' && Number.isFinite(item.updatedAt) ? item.updatedAt : 0,
            summary: typeof item.summary === 'string' ? item.summary : kind,
        };
        if (kind === 'checkpoint') {catalog.push({...base, kind});}
        else if (kind === 'entity_rules') {catalog.push({...base, kind});}
        else if (kind === 'recording') {catalog.push({...base, kind});}
        else {catalog.push({...base, kind});}
    }
    return catalog;
};
