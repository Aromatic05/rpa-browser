import path from 'node:path';
import type { Checkpoint } from '../runner/checkpoint';
import type { StepResolve } from '../runner/steps/types';
import type { CheckpointHintFile, CheckpointResolveFile, SingleCheckpointFile } from '../runner/serialization/types';
import { validateCheckpointResolveFileForSerialization, validateSingleCheckpointFileForSerialization } from '../runner/serialization/types';
import { listDirectories, readValidatedYamlFile, readYamlFile, removePath, requireArtifactName, workflowArtifactPath, workflowRootDir, writeYamlFile } from './fs';
import { invalidWorkflowArtifact } from './errors';
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
    workflowArtifactPath(workflowName, 'checkpoints', requireArtifactName(checkpointName, 'checkpoint ID'));

export const createCheckpointCodec = (workflowName: string): WorkflowCodec<WorkflowCheckpoint> => ({
    kind: 'checkpoint',
    is: (value: unknown): value is WorkflowCheckpoint =>
        isRecord(value) && value.kind === 'checkpoint' && typeof value.name === 'string' && isArtifactName(value.name),
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
            const resolveFile = readOptionalResolveFile(path.join(dir, 'checkpoint_resolve.yaml'));
            const stepResolves = resolveFile?.resolves ?? {};
            const hints = readOptionalHints(path.join(dir, 'checkpoint_hints.yaml'));
            return { kind: 'checkpoint', name, checkpoint: checkpointFile.checkpoint, stepResolves, hints };
        } catch (error) {
            if (isMissingFile(error)) {return null;}
            throw invalidWorkflowArtifact('checkpoint', name, error);
        }
    },
    list: () =>
        listDirectories(workflowArtifactPath(workflowName, 'checkpoints'))
            .filter(isArtifactName)
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

const readOptionalResolveFile = (filePath: string): CheckpointResolveFile | null => {
    try {
        return readValidatedYamlFile<CheckpointResolveFile>(filePath, validateCheckpointResolveFileForSerialization);
    } catch (error) {
        if (isMissingFile(error)) {return null;}
        throw error;
    }
};

const readOptionalHints = (filePath: string): CheckpointHintFile['hints'] => {
    try {
        return parseCheckpointHints(readYamlFile(filePath));
    } catch (error) {
        if (isMissingFile(error)) {return {};}
        throw error;
    }
};

const isMissingFile = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isArtifactName = (name: string): boolean => {
    try {
        requireArtifactName(name, 'checkpoint ID');
        return true;
    } catch {
        return false;
    }
};

export const createWorkflowCheckpointProvider = (
    checkpoints: Map<string, WorkflowCheckpoint>,
): DslCheckpointProvider => ({
    getCheckpoint: (id: string) => checkpoints.get(id)?.checkpoint ?? null,
    getCheckpointResolves: (id: string) => checkpoints.get(id)?.stepResolves ?? null,
    listCheckpoints: () => [...checkpoints.values()].map((item) => item.checkpoint),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCheckpointHints = (value: unknown): CheckpointHintFile['hints'] => {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.hints)) {
        throw new Error('invalid checkpoint hints file');
    }
    return value.hints as CheckpointHintFile['hints'];
};
