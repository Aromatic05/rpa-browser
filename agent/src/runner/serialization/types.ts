import type { Checkpoint } from '../checkpoint/types';
import type { StepResolve, StepUnion } from '../steps/types';

export type StepFile = {
    version: 1;
    steps: StepUnion[];
};

export type StepHint = {
    entity?: {
        businessTag?: string;
        fieldKey?: string;
        actionIntent?: string;
    };
    target?: {
        role?: string;
        tag?: string;
        name?: string;
        text?: string;
    };
    locatorCandidates?: Array<{
        kind: string;
        query?: string;
        selector?: string;
        testId?: string;
        role?: string;
        name?: string;
        text?: string;
        exact?: boolean;
        note?: string;
    }>;
    recordedAt?: {
        url?: string;
        timestamp?: number;
    };
    rawContext?: Record<string, unknown>;
};

export type StepHintFile = {
    version: 1;
    hints: Record<string, StepHint>;
};

export type CheckpointFile = {
    version: 1;
    checkpoints: Checkpoint[];
};

export type CheckpointHint = {
    why?: string;
    scope?: {
        businessTag?: string;
    };
    preferredEntityRules?: string[];
    fallbacks?: Array<{
        kind: string;
        text?: string;
        role?: string;
        name?: string;
        query?: string;
    }>;
    notes?: string[];
};

export type CheckpointHintFile = {
    version: 1;
    hints: Record<string, CheckpointHint>;
};

export const validateStepFileForSerialization = (file: StepFile): void => {
    if (file.version !== 1) {
        throw new Error(`invalid step file version: ${String(file.version)}`);
    }
    if (!Array.isArray(file.steps)) {
        throw new Error('step file must contain a steps array');
    }
    for (const step of file.steps) {
        if (!step || typeof step !== 'object') {
            throw new Error('step entry must be an object');
        }
        if (!step.id || !step.name || !('args' in step)) {
            throw new Error('step entry must include id, name, and args');
        }
        assertNoSerializedStepHints(step);
    }
};

export const validateCheckpointFileForSerialization = (file: CheckpointFile): void => {
    if (file.version !== 1) {
        throw new Error(`invalid checkpoint file version: ${String(file.version)}`);
    }
    if (!Array.isArray(file.checkpoints)) {
        throw new Error('checkpoint file must contain a checkpoints array');
    }
    for (const checkpoint of file.checkpoints) {
        if (!checkpoint || typeof checkpoint !== 'object') {
            throw new Error('checkpoint entry must be an object');
        }
        if (!checkpoint.id) {
            throw new Error('checkpoint entry must include id');
        }
        if (!checkpoint.trigger || !Array.isArray(checkpoint.trigger.matchRules)) {
            throw new Error(`checkpoint ${checkpoint.id} must use trigger.matchRules`);
        }
        if ('matchRules' in checkpoint) {
            throw new Error(`checkpoint ${checkpoint.id} must not include top-level matchRules`);
        }
        if (checkpoint.policy && 'trigger' in checkpoint.policy) {
            throw new Error(`checkpoint ${checkpoint.id} must not include policy.trigger.matchRules`);
        }
    }
};

const assertNoSerializedStepHints = (step: StepUnion): void => {
    if (step.resolve) {
        throw new Error(`step ${step.id} must not include resolve in steps.yaml`);
    }
    assertResolveHintAbsent(step.resolve, step.id);
    const argsObject = step.args as Record<string, unknown>;
    for (const key of ['hint', 'rawContext', 'locatorCandidates', 'replayHints']) {
        if (key in argsObject) {
            throw new Error(`step ${step.id} must not include ${key} in steps.yaml`);
        }
    }
};

const assertResolveHintAbsent = (resolve: StepResolve | undefined, stepId: string): void => {
    if (!resolve) {return;}
    if (resolve.hint) {
        throw new Error(`step ${stepId} must not include resolve.hint in steps.yaml`);
    }
};
