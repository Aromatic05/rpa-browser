import path from 'node:path';
import { DslRuntimeError } from '../dsl/diagnostics/errors';
import { createCheckpointCodec, createWorkflowCheckpointProvider, type WorkflowCheckpoint } from './checkpoint';
import { createDslCodec, type WorkflowDsl } from './dsl';
import { ensureDir, existsDir, listDirectories, readYamlFile, removePath, workflowManifestPath, workflowRootDir, workflowsRootDir, writeYamlFile } from './fs';
import { createEntityRulesCodec, type WorkflowEntityRules } from './entity_rules';
import { createRecordingCodec, type WorkflowRecording } from './recording';
import { createNamedStore, type NamedStore, type WorkflowCodec } from './store';

export type WorkflowArtifact = WorkflowRecording | WorkflowCheckpoint | WorkflowDsl | WorkflowEntityRules;

export type WorkflowManifest = {
    version: 1;
    name: string;
    entry: { dsl: string };
    createdAt: number;
    updatedAt: number;
    recordings: string[];
    checkpoints: string[];
    dsls: string[];
    entity_rules: string[];
};

export type WorkflowCatalogView = Pick<WorkflowManifest, 'name' | 'entry' | 'createdAt' | 'updatedAt' | 'recordings' | 'checkpoints' | 'dsls' | 'entity_rules'>;

export type Workflow = {
    name: string;
    manifest: WorkflowManifest;
    save: (value: WorkflowArtifact) => WorkflowArtifact;
    get: (name: string) => WorkflowArtifact | null;
    list: () => WorkflowCatalogView;
    delete: (name: string) => boolean;
    getCheckpointProvider: () => import('../dsl/emit').DslCheckpointProvider;
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
    recordings: [],
    checkpoints: [],
    dsls: [],
    entity_rules: [],
});

const readManifest = (workflowName: string): WorkflowManifest => {
    const filePath = workflowManifestPath(workflowName);
    return readYamlFile<WorkflowManifest>(filePath);
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

const updateCatalog = (manifest: WorkflowManifest, artifact: WorkflowArtifact): void => {
    const set = (items: string[]): string[] => Array.from(new Set(items)).sort();
    if (artifact.kind === 'recording') {
        manifest.recordings = set([...manifest.recordings, artifact.name]);
    } else if (artifact.kind === 'checkpoint') {
        manifest.checkpoints = set([...manifest.checkpoints, artifact.name]);
    } else if (artifact.kind === 'dsl') {
        manifest.dsls = set([...manifest.dsls, artifact.name]);
        if (artifact.name === 'main') {
            manifest.entry.dsl = artifact.name;
        }
    } else {
        manifest.entity_rules = set([...manifest.entity_rules, artifact.name]);
    }
};

const removeFromCatalog = (manifest: WorkflowManifest, name: string): void => {
    const remove = (items: string[]) => items.filter((item) => item !== name);
    manifest.recordings = remove(manifest.recordings);
    manifest.checkpoints = remove(manifest.checkpoints);
    manifest.dsls = remove(manifest.dsls);
    manifest.entity_rules = remove(manifest.entity_rules);
};

export const loadWorkflowFromFs = (workflowName: string): Workflow => {
    if (!existsDir(workflowRootDir(workflowName))) {
        throw new DslRuntimeError(`workflow not found: ${workflowName}`, 'ERR_WORKFLOW_NOT_FOUND');
    }
    const manifest = readManifest(workflowName);
    const internal = createInternal(workflowName);
    const workflow: Workflow = {
        name: workflowName,
        manifest,
        save: (value) => {
            const codec = internal.codecs.find((item) => item.is(value));
            if (!codec) {
                throw new DslRuntimeError('unsupported workflow artifact type', 'ERR_WORKFLOW_BAD_ARGS');
            }
            const saved = codec.save(value as never) as WorkflowArtifact;
            updateCatalog(manifest, saved);
            writeManifest(manifest);
            return saved;
        },
        get: (name) => {
            if (manifest.recordings.includes(name)) {
                return internal.recordingStore.get(name);
            }
            if (manifest.checkpoints.includes(name)) {
                return internal.checkpointStore.get(name);
            }
            if (manifest.dsls.includes(name)) {
                return internal.dslStore.get(name);
            }
            if (manifest.entity_rules.includes(name)) {
                return internal.entityRuleStore.get(name);
            }
            return null;
        },
        list: () => ({
            name: manifest.name,
            entry: manifest.entry,
            createdAt: manifest.createdAt,
            updatedAt: manifest.updatedAt,
            recordings: [...manifest.recordings],
            checkpoints: [...manifest.checkpoints],
            dsls: [...manifest.dsls],
            entity_rules: [...manifest.entity_rules],
        }),
        delete: (name) => {
            let deleted = false;
            if (manifest.recordings.includes(name)) {
                deleted = internal.recordingStore.delete(name);
            }
            if (manifest.checkpoints.includes(name)) {
                deleted = internal.checkpointStore.delete(name) || deleted;
            }
            if (manifest.dsls.includes(name)) {
                deleted = internal.dslStore.delete(name) || deleted;
            }
            if (manifest.entity_rules.includes(name)) {
                deleted = internal.entityRuleStore.delete(name) || deleted;
            }
            removeFromCatalog(manifest, name);
            writeManifest(manifest);
            return deleted;
        },
        getCheckpointProvider: () => {
            const checkpoints = new Map<string, WorkflowCheckpoint>();
            for (const name of manifest.checkpoints) {
                const loaded = internal.checkpointStore.get(name);
                if (loaded) {
                    checkpoints.set(name, loaded);
                }
            }
            return createWorkflowCheckpointProvider(checkpoints);
        },
    };
    return workflow;
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
