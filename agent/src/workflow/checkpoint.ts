import path from 'node:path';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { CheckpointHintFile, CheckpointResolveFile, SingleCheckpointFile } from '../runner/serialization/types';
import { validateCheckpointResolveFileForSerialization, validateSingleCheckpointFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readValidatedYamlFile, readYamlFile, removePath, workflowRootDir, writeYamlFile } from './fs';
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
    is: (value: unknown): value is WorkflowCheckpoint =>
        isRecord(value) && value.kind === 'checkpoint' && typeof value.name === 'string' && value.name.length > 0,
    load: (name) => {
        const dir = checkpointDir(workflowName, name);
        try {
            const checkpointFile = readValidatedYamlFile<SingleCheckpointFile>(
                path.join(dir, 'checkpoint.yaml'),
                validateSingleCheckpointFileForSerialization,
            );
            if (checkpointFile.checkpoint.id !== name) {
                throw new Error(`checkpoint identity mismatch: artifact=${name} checkpoint.id=${checkpointFile.checkpoint.id}`);
            }
            let stepResolves: Record<string, StepResolve> = {};
            try {
                const resolveFile = readValidatedYamlFile<CheckpointResolveFile>(
                    path.join(dir, 'checkpoint_resolve.yaml'),
                    validateCheckpointResolveFileForSerialization,
                );
                stepResolves = resolveFile.resolves;
            } catch {
                // Optional sidecar: absence or invalid content falls back to no resolves.
            }
            let hints: CheckpointHintFile['hints'] = {};
            try {
                hints = parseCheckpointHints(readYamlFile(path.join(dir, 'checkpoint_hints.yaml')));
            } catch {
                // Optional sidecar: absence or invalid content falls back to no hints.
            }
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
        if (value.checkpoint.id !== value.name) {
            throw new Error(`checkpoint identity mismatch: artifact=${value.name} checkpoint.id=${value.checkpoint.id}`);
        }
        const dir = checkpointDir(workflowName, value.name);
        const checkpointFile: SingleCheckpointFile = { version: 1, checkpoint: value.checkpoint };
        validateSingleCheckpointFileForSerialization(checkpointFile);
        const resolveFile: CheckpointResolveFile = { version: 1, resolves: value.stepResolves };
        validateCheckpointResolveFileForSerialization(resolveFile);
        writeYamlFile(path.join(dir, 'checkpoint.yaml'), checkpointFile);
        writeYamlFile(path.join(dir, 'checkpoint_resolve.yaml'), resolveFile);
        writeYamlFile(path.join(dir, 'checkpoint_hints.yaml'), { version: 1, hints: value.hints });
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
    getCheckpoint: (id: string) => checkpoints.get(id)?.checkpoint ?? null,
    getCheckpointResolves: (id: string) => checkpoints.get(id)?.stepResolves ?? null,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCheckpointHints = (value: unknown): CheckpointHintFile['hints'] => {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.hints)) {
        throw new Error('invalid checkpoint hints file');
    }
    return value.hints as CheckpointHintFile['hints'];
};
