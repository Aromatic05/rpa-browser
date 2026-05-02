import path from 'node:path';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { CheckpointHintFile, CheckpointResolveFile, SingleCheckpointFile } from '../runner/serialization/types';
import { validateCheckpointResolveFileForSerialization, validateSingleCheckpointFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readYamlFile, removePath, workflowRootDir, writeYamlFile } from './fs';
import type { WorkflowCodec } from './store';
import type { DslCheckpointProvider } from '../dsl/emit';

export type WorkflowCheckpoint = {
    kind: 'checkpoint';
    name: string;
    checkpoint: Checkpoint;
    stepResolves: Record<string, StepResolve>;
    hints: CheckpointHintFile['hints'];
};

const checkpointDir = (workflowName: string, checkpointName: string): string =>
    path.join(workflowRootDir(workflowName), 'checkpoints', checkpointName);

export const createCheckpointCodec = (workflowName: string): WorkflowCodec<WorkflowCheckpoint> => ({
    kind: 'checkpoint',
    is: (value: unknown): value is WorkflowCheckpoint => {
        const rec = value as Partial<WorkflowCheckpoint>;
        return !!rec && rec.kind === 'checkpoint' && typeof rec.name === 'string' && !!rec.name;
    },
    load: (name) => {
        const dir = checkpointDir(workflowName, name);
        try {
            const checkpointFile = readYamlFile<SingleCheckpointFile>(path.join(dir, 'checkpoint.yaml'));
            validateSingleCheckpointFileForSerialization(checkpointFile);
            let stepResolves: Record<string, StepResolve> = {};
            try {
                const resolveFile = readYamlFile<CheckpointResolveFile>(path.join(dir, 'checkpoint_resolve.yaml'));
                validateCheckpointResolveFileForSerialization(resolveFile);
                stepResolves = resolveFile.resolves || {};
            } catch {}
            let hints: CheckpointHintFile['hints'] = {};
            try {
                hints = readYamlFile<CheckpointHintFile>(path.join(dir, 'checkpoint_hints.yaml')).hints || {};
            } catch {}
            return { kind: 'checkpoint', name, checkpoint: checkpointFile.checkpoint, stepResolves, hints };
        } catch {
            return null;
        }
    },
    list: () =>
        listDirectories(path.join(workflowRootDir(workflowName), 'checkpoints'))
            .map((name) => createCheckpointCodec(workflowName).load(name))
            .filter((item): item is WorkflowCheckpoint => item !== null),
    save: (value) => {
        const dir = checkpointDir(workflowName, value.name);
        const checkpointFile: SingleCheckpointFile = { version: 1, checkpoint: value.checkpoint };
        validateSingleCheckpointFileForSerialization(checkpointFile);
        const resolveFile: CheckpointResolveFile = { version: 1, resolves: value.stepResolves || {} };
        validateCheckpointResolveFileForSerialization(resolveFile);
        writeYamlFile(path.join(dir, 'checkpoint.yaml'), checkpointFile);
        writeYamlFile(path.join(dir, 'checkpoint_resolve.yaml'), resolveFile);
        writeYamlFile(path.join(dir, 'checkpoint_hints.yaml'), { version: 1, hints: value.hints || {} });
        return value;
    },
    delete: (name) => {
        removePath(checkpointDir(workflowName, name));
        return true;
    },
});

export const createWorkflowCheckpointProvider = (
    checkpoints: Map<string, WorkflowCheckpoint>,
): DslCheckpointProvider => ({
    getCheckpoint: (id: string) => checkpoints.get(id)?.checkpoint || null,
    getCheckpointResolves: (id: string) => checkpoints.get(id)?.stepResolves || null,
});
