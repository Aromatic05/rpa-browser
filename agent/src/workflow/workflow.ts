import path from 'node:path';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { createCheckpointCodec, type WorkflowCheckpoint } from './checkpoint';
import { createDslCodec, type WorkflowDsl } from './dsl';
import { ensureDir, existsDir, listDirectories, readYamlFile, removePath, workflowManifestPath, workflowRootDir, workflowsRootDir, writeYamlFile } from './fs';
import { createEntityRulesCodec, type WorkflowEntityRules } from './entity_rules';
import { createRecordingCodec, type WorkflowRecording } from './recording';
import { createNamedStore, type NamedStore, type WorkflowCodec } from './store';

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

export type WorkflowEntityRulesCatalogItem = WorkflowCatalogItemBase & {
    kind: 'entity_rules';
    enabled?: boolean;
};

export type WorkflowCatalogItem =
    | (WorkflowCatalogItemBase & { kind: 'recording' })
    | WorkflowCheckpointCatalogItem
    | (WorkflowCatalogItemBase & { kind: 'dsl' })
    | WorkflowEntityRulesCatalogItem;

export type WorkflowManifest = {
    version: 1;
    name: string;
    entry: { dsl: string };
    createdAt: number;
    updatedAt: number;
    catalog: WorkflowCatalogItem[];
};

export type Workflow = {
    save: (value: WorkflowArtifact) => WorkflowArtifact;
    get: (name: string, dummy: WorkflowDummy) => WorkflowArtifact | null;
    list: (dummy: WorkflowDummy) => WorkflowCatalogItem[];
    delete: (name: string, dummy: WorkflowDummy) => boolean;
};

type WorkflowInternal = {
    recordingStore: NamedStore<WorkflowRecording>;
    checkpointStore: NamedStore<WorkflowCheckpoint>;
    dslStore: NamedStore<WorkflowDsl>;
    entityRuleStore: NamedStore<WorkflowEntityRules>;
    codecs: WorkflowCodec<WorkflowArtifact>[];
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
    const parsed = readYamlFile<WorkflowManifest>(filePath);
    if (!parsed || typeof parsed !== 'object' || parsed.version !== 1 || typeof parsed.name !== 'string') {
        throw new DslRuntimeError(`invalid workflow manifest: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    if (!parsed.entry || typeof parsed.entry !== 'object' || typeof parsed.entry.dsl !== 'string') {
        throw new DslRuntimeError(`invalid workflow manifest entry: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    if (!Array.isArray(parsed.catalog)) {
        throw new DslRuntimeError(`invalid workflow manifest catalog: ${workflowName}`, 'ERR_WORKFLOW_INVALID_MANIFEST');
    }
    return parsed;
};

const writeManifest = (manifest: WorkflowManifest): void => {
    manifest.updatedAt = Date.now();
    writeYamlFile(workflowManifestPath(manifest.name), manifest);
};

const createInternal = (workflowName: string): WorkflowInternal => {
    const recordingStore = createNamedStore(createRecordingCodec(workflowName));
    const checkpointStore = createNamedStore(createCheckpointCodec(workflowName));
    const dslStore = createNamedStore(createDslCodec(workflowName));
    const entityRuleStore = createNamedStore(createEntityRulesCodec(workflowName));
    const codecs: WorkflowCodec<WorkflowArtifact>[] = [
        createRecordingCodec(workflowName) as WorkflowCodec<WorkflowArtifact>,
        createCheckpointCodec(workflowName) as WorkflowCodec<WorkflowArtifact>,
        createDslCodec(workflowName) as WorkflowCodec<WorkflowArtifact>,
        createEntityRulesCodec(workflowName) as WorkflowCodec<WorkflowArtifact>,
    ];
    return { recordingStore, checkpointStore, dslStore, entityRuleStore, codecs };
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
        };
    }
    if (artifact.kind === 'recording') {
        return { ...base, kind: 'recording', summary: `steps=${artifact.steps.length}` };
    }
    return { ...base, kind: 'dsl', summary: `bytes=${artifact.content.length}` };
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
    return internal.entityRuleStore as NamedStore<WorkflowArtifact>;
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
        save: (value) => {
            const codec = internal.codecs.find((item) => item.is(value));
            if (!codec) {
                throw new DslRuntimeError('unsupported workflow artifact type', 'ERR_WORKFLOW_BAD_ARGS');
            }
            const saved = codec.save(value as never) as WorkflowArtifact;
            const idx = manifest.catalog.findIndex((item) => item.kind === saved.kind && item.name === saved.name);
            const nextItem = toCatalogItem(saved, idx >= 0 ? manifest.catalog[idx] : undefined);
            if (idx >= 0) {
                manifest.catalog[idx] = nextItem;
            } else {
                manifest.catalog.push(nextItem);
            }
            if (saved.kind === 'dsl' && saved.name === 'main') {
                manifest.entry.dsl = 'main';
            }
            writeManifest(manifest);
            return saved;
        },
        get: (name, dummy) => {
            if (!hasCatalog(manifest, dummy.kind, name)) {
                return null;
            }
            return resolveStore(internal, dummy.kind).get(name);
        },
        list: (dummy) => manifest.catalog.filter((item) => item.kind === dummy.kind),
        delete: (name, dummy) => {
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

export const listWorkflowNames = (): string[] => listDirectories(workflowsRootDir());
export const deleteWorkflowFromFs = (workflowName: string): void => removePath(workflowRootDir(workflowName));
