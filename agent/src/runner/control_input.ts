import {ActionError, ERROR_CODES} from '../actions/results';
import type {Checkpoint as RunnerCheckpoint} from './checkpoint';
import {
    validateCheckpointFileForSerialization,
    validateStepFileForSerialization,
    validateStepResolveFileForSerialization,
} from './serialization/types';
import type {StepResolve, StepUnion} from './steps/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const invalidAsset = (label: string, error?: unknown): ActionError => new ActionError(
    ERROR_CODES.ERR_BAD_ARGS,
    `invalid ${label}${error instanceof Error ? `: ${error.message}` : ''}`,
);

export const readStepResolves = (
    value: unknown,
    label = 'stepResolves',
): Record<string, StepResolve> => {
    if (value === undefined) {return {};}
    if (!isRecord(value)) {throw invalidAsset(label);}
    const resolves = structuredClone(value) as Record<string, StepResolve>;
    const file = {version: 1 as const, resolves: structuredClone(resolves)};
    try {
        validateStepResolveFileForSerialization(file);
    } catch (error) {
        throw invalidAsset(label, error);
    }
    return resolves;
};

export const readCheckpointStepResolves = (
    value: unknown,
): Record<string, Record<string, StepResolve>> => {
    if (value === undefined) {return {};}
    if (!isRecord(value)) {throw invalidAsset('checkpointStepResolves');}
    const result: Record<string, Record<string, StepResolve>> = {};
    for (const [checkpointId, resolves] of Object.entries(value)) {
        if (!checkpointId) {throw invalidAsset('checkpointStepResolves checkpoint id');}
        result[checkpointId] = readStepResolves(resolves, `checkpointStepResolves.${checkpointId}`);
    }
    return result;
};

export const readCheckpointBodies = (value: unknown): Record<string, string> => {
    if (value === undefined) {return {};}
    if (!isRecord(value)) {throw invalidAsset('checkpointBodies');}
    const bodies: Record<string, string> = {};
    for (const [checkpointId, body] of Object.entries(value)) {
        if (!checkpointId || typeof body !== 'string') {
            throw invalidAsset(`checkpointBodies.${checkpointId || '<empty>'}`);
        }
        bodies[checkpointId] = body;
    }
    return bodies;
};

export const readCheckpoints = (value: unknown): RunnerCheckpoint[] => {
    if (value === undefined) {return [];}
    if (!Array.isArray(value)) {throw invalidAsset('checkpoints');}
    const checkpoints = structuredClone(value) as RunnerCheckpoint[];
    try {
        validateCheckpointFileForSerialization({version: 1, checkpoints});
    } catch (error) {
        throw invalidAsset('checkpoints', error);
    }
    return checkpoints;
};

export const readSteps = (value: unknown): StepUnion[] => {
    if (value === undefined) {return [];}
    if (!Array.isArray(value)) {throw invalidAsset('steps');}
    const steps = structuredClone(value) as StepUnion[];
    try {
        validateStepFileForSerialization({version: 1, steps: structuredClone(steps)});
    } catch (error) {
        throw invalidAsset('steps', error);
    }
    return steps;
};

export const readPollCursor = (value: unknown, resultCount: number): number => {
    if (value === undefined) {return 0;}
    if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > resultCount) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'poll cursor is outside the available result range');
    }
    return value as number;
};

export const readPollLimit = (value: unknown): number => {
    if (value === undefined) {return 100;}
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'poll limit must be a positive integer');
    }
    return value as number;
};
