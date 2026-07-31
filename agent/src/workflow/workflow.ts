import path from 'node:path';
import fs from 'node:fs';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { createCheckpointCodec, type WorkflowCheckpoint } from './checkpoint';
import { createDslCodec, type WorkflowDsl } from './dsl';
import { ensureDir, existsDir, listDirectories, readYamlFile, removePath, requireArtifactName, workflowManifestPath, workflowRootDir, workflowsRootDir, writeYamlFile } from './fs';
import { createRecordingCodec, type WorkflowRecording } from './recording';
import { createEntityRulesCodec, type WorkflowEntityRules } from './entity_rules';
import { createNamedStore, type NamedStore } from './store';

export type WorkflowArtifactKind = 'recording' | 'checkpoint' | 'dsl' | 'entity_rules';
export type WorkflowDummy = { kind: WorkflowArtifactKind };

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
        throw new DslRuntimeError(`invalid workflow manifest: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    if (!isRecord(parsed.entry) || typeof parsed.entry.dsl !== 'string') {
        throw new DslRuntimeError(`invalid workflow manifest entry: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    if (!Array.isArray(parsed.catalog)) {
        throw new DslRuntimeError(`invalid workflow manifest catalog: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    return parseWorkflowManifest(parsed, workflowName);
};

const writeManifest = (manifest: WorkflowManifest): void => {
    manifest.updatedAt = Date.now();
    writeYamlFile(workflowManifestPath(manifest.name), manifest);
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
        title: artifact.name,
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

const hasCatalog = (manifest: WorkflowManifest, kind: WorkflowArtifactKind, name: string): boolean =>
    manifest.catalog.some((item) => item.kind === kind && item.name === name);

export const loadWorkflowFromFs = (workflowName: string): Workflow => {
    if (!existsDir(workflowRootDir(workflowName))) {
        throw new DslRuntimeError(`workflow not found: ${workflowName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    const manifest = readManifest(workflowName);
    const internal = createInternal(workflowName);

    return {
        name: workflowName,
        entryDslName: () => manifest.entry.dsl,
        save: (value) => {
            const saved = saveArtifact(internal, value);
            const idx = manifest.catalog.findIndex((item) => item.kind === saved.kind && item.name === saved.name);
            const nextItem = toCatalogItem(saved, idx >= 0 ? manifest.catalog[idx] : undefined);
            if (idx >= 0) {
                manifest.catalog[idx] = nextItem;
            } else {
                manifest.catalog.push(nextItem);
            }
            writeManifest(manifest);
            return saved;
        },
        get: (name, dummy) => {
            requireArtifactName(name, `${dummy.kind} artifact name`);
            if (!hasCatalog(manifest, dummy.kind, name)) {
                return null;
            }
            return resolveStore(internal, dummy.kind).get(name);
        },
        list: (dummy) => manifest.catalog.filter((item) => item.kind === dummy.kind),
        delete: (name, dummy) => {
            requireArtifactName(name, `${dummy.kind} artifact name`);
            if (dummy.kind === 'dsl' && name === manifest.entry.dsl) {
                throw new DslRuntimeError(`cannot delete workflow entry DSL: ${name}`, 'ERR_WORKFLOW_BAD_ARGS');
            }
            const deleted = resolveStore(internal, dummy.kind).delete(name);
            manifest.catalog = manifest.catalog.filter((item) => !(item.kind === dummy.kind && item.name === name));
            writeManifest(manifest);
            return deleted;
        },
    };
};

export const createWorkflowOnFs = (workflowName: string): Workflow => {
    const rootDir = workflowRootDir(workflowName);
    if (existsDir(rootDir)) {
        throw new DslRuntimeError(`workflow already exists: ${workflowName}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    ensureDir(path.join(rootDir, 'recordings'));
    ensureDir(path.join(rootDir, 'checkpoints'));
    ensureDir(path.join(rootDir, 'dsls'));
    ensureDir(path.join(rootDir, 'entity_rules'));
    const manifest = defaultManifest(workflowName);
    writeYamlFile(workflowManifestPath(workflowName), manifest);
    return loadWorkflowFromFs(workflowName);
};

export const ensureWorkflowOnFs = (workflowName: string): Workflow => {
    if (existsDir(workflowRootDir(workflowName))) {
        return loadWorkflowFromFs(workflowName);
    }
    return createWorkflowOnFs(workflowName);
};

export const renameWorkflowOnFs = (fromName: string, toName: string): void => {
    const fromDir = workflowRootDir(fromName);
    const toDir = workflowRootDir(toName);
    if (!existsDir(fromDir)) {
        throw new DslRuntimeError(`workflow not found: ${fromName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    if (existsDir(toDir)) {
        throw new DslRuntimeError(`workflow already exists: ${toName}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    fs.renameSync(fromDir, toDir);
    const renamedManifestPath = workflowManifestPath(toName);
    const manifest = parseWorkflowManifest(readYamlFile(renamedManifestPath), toName);
writeYamlFile(renamedManifestPath, {
        ...manifest,
        name: toName,
        updatedAt: Date.now(),
    } satisfies WorkflowManifest);
};

export const copyWorkflowOnFs = (sourceName: string, targetName: string): void => {
    const sourceDir = workflowRootDir(sourceName);
    const targetDir = workflowRootDir(targetName);
    if (!existsDir(sourceDir)) {
        throw new DslRuntimeError(`workflow not found: ${sourceName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    if (existsDir(targetDir)) {
        throw new DslRuntimeError(`workflow already exists: ${targetName}`, 'ERR_WORKFLOW_BAD_ARGS');
    }
    fs.cpSync(sourceDir, targetDir, { recursive: true });
    const copiedManifestPath = workflowManifestPath(targetName);
    const manifest = parseWorkflowManifest(readYamlFile(copiedManifestPath), targetName);
writeYamlFile(copiedManifestPath, {
        ...manifest,
        name: targetName,
        updatedAt: Date.now(),
    } satisfies WorkflowManifest);
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
    removePath(workflowRootDir(workflowName));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseWorkflowManifest = (value: unknown, workflowName: string): WorkflowManifest => {
    if (!isRecord(value) || value.version !== 1 || typeof value.name !== 'string'
        || !isRecord(value.entry) || typeof value.entry.dsl !== 'string' || !Array.isArray(value.catalog)
        || typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') {
        throw new DslRuntimeError(
            `invalid workflow manifest: ${workflowName}`,
            'ERR_WORKFLOW_INVALID_MANIFEST',
        );
    }
    requireArtifactName(value.name, 'workflow name');
    requireArtifactName(value.entry.dsl, 'workflow entry DSL name');
    for (const item of value.catalog) {
        if (!isRecord(item) || typeof item.kind !== 'string' || typeof item.name !== 'string') {
            throw new DslRuntimeError(`invalid workflow manifest catalog: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
        }
        requireArtifactName(item.name, `${item.kind} artifact name`);
    }
    return value as WorkflowManifest;
};
