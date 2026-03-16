import type { StepResult, StepUnion } from '../runner/steps/types';

export type TaskRunStatus = 'running' | 'completed' | 'failed' | 'aborted';

export type StepEnvelope = {
    seq?: number;
    step: StepUnion;
    vars?: Record<string, unknown>;
};

export type StepResultEnvelope = {
    runId: string;
    taskId: string;
    workspaceId: string;
    seq: number;
    stepId: string;
    ok: boolean;
    status: 'ok' | 'error';
    outputs?: Record<string, unknown>;
    raw?: StepResult['data'];
    error?: StepResult['error'];
    ts: number;
};

export type TaskCheckpoint = {
    runId: string;
    taskId: string;
    workspaceId: string;
    status: TaskRunStatus;
    nextSeq: number;
    emittedCount: number;
    lastError?: { code: string; message: string; details?: unknown };
    updatedAt: number;
};

export type TaskRun = {
    runId: string;
    taskId: string;
    workspaceId: string;
    status: TaskRunStatus;
    nextSeq: number;
    emitted: StepResultEnvelope[];
    createdAt: number;
    updatedAt: number;
    lastError?: { code: string; message: string; details?: unknown };
};
