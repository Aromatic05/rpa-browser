import crypto from 'node:crypto';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    enqueueSteps,
    readResultPipe,
    runSteps,
    waitForResultPipe,
    type Checkpoint,
    type RunStepsDeps,
    type StepResult,
} from '../../runner/run_steps';
import type { StepUnion } from '../../runner/steps/types';

const DEFAULT_POLL_LIMIT = 100;

export type DslTaskRunner = {
    start(): Promise<{ runId: string }>;
    runStep(step: StepUnion): Promise<StepResult>;
    close(): Promise<void>;
};

export type CreateDslTaskRunnerOptions = {
    workspaceId: string;
    deps: RunStepsDeps;
    stopOnError?: boolean;
};

export const createDslTaskRunner = (options: CreateDslTaskRunnerOptions): DslTaskRunner => {
    const runId = `dsl:${crypto.randomUUID()}`;
    const queue = createStepsQueue();
    const pipe = createResultPipe();
    const signals = createSignalChannel();

    let readCursor = 0;
    let started = false;
    let latestCheckpoint: Checkpoint = {
        runId,
        workspaceId: options.workspaceId,
        status: 'running',
        cursor: 0,
        updatedAt: Date.now(),
    };

    const runPromise = runSteps(
        {
            runId,
            workspaceId: options.workspaceId,
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: options.stopOnError ?? true,
            onCheckpoint: async (checkpoint) => {
                latestCheckpoint = checkpoint;
            },
        },
        options.deps,
    );

    const start = async (): Promise<{ runId: string }> => {
        started = true;
        return { runId };
    };

    const runStep = async (step: StepUnion): Promise<StepResult> => {
        if (!started) {
            await start();
        }

        enqueueSteps(queue, [step]);
        return await waitForStepResult(step.id);
    };

    const close = async (): Promise<void> => {
        closeStepsQueue(queue);
        await runPromise;
    };

    const waitForStepResult = async (stepId: string): Promise<StepResult> => {
        while (true) {
            const { items, nextCursor } = readResultPipe(pipe, readCursor, DEFAULT_POLL_LIMIT);
            readCursor = nextCursor;

            const found = items.find((item) => item.stepId === stepId);
            if (found) {
                return found;
            }

            if (isTerminal(latestCheckpoint.status)) {
                return {
                    runId,
                    cursor: latestCheckpoint.cursor,
                    stepId,
                    ok: false,
                    error: {
                        code: latestCheckpoint.status === 'failed' ? 'ERR_DSL_TASK_FAILED' : 'ERR_DSL_STEP_MISSING_RESULT',
                        message:
                            latestCheckpoint.status === 'failed'
                                ? `task run failed before step result was observed: ${stepId}`
                                : `runner returned no result for step: ${stepId}`,
                    },
                    ts: Date.now(),
                };
            }

            await waitForResultPipe(pipe);
        }
    };

    return {
        start,
        runStep,
        close,
    };
};

const isTerminal = (status: Checkpoint['status']): boolean =>
    status === 'completed' || status === 'failed' || status === 'halted';
