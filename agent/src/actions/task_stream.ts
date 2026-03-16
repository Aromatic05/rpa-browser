import crypto from 'node:crypto';
import path from 'node:path';
import { makeErr, makeOk } from './action_protocol';
import type { ActionHandler } from './execute';
import { ERROR_CODES } from './error_codes';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    enqueueSteps,
    readResultPipe,
    runSteps,
    sendSignal,
    type Checkpoint,
    type ResultPipe,
    type RunStatus,
    type SignalChannel,
    type StepsQueue,
} from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';
import { createTaskCheckpointStore, type TaskRunCheckpoint } from '../runner/checkpoint_store';
import { getRunnerConfig } from '../runner/config';

type TaskRunState = {
    runId: string;
    workspaceId: string;
    status: RunStatus;
    queue: StepsQueue;
    pipe: ResultPipe;
    signals: SignalChannel;
    checkpoint: Checkpoint;
};

const runs = new Map<string, TaskRunState>();
const runnerConfig = getRunnerConfig();
const checkpointStore = createTaskCheckpointStore(
    path.resolve(process.cwd(), runnerConfig.checkpointPolicy.filePath),
    { flushIntervalMs: runnerConfig.checkpointPolicy.flushIntervalMs },
);
const checkpointEnabled = runnerConfig.checkpointPolicy.enabled;
let checkpointLoaded = false;

const ensureCheckpointLoaded = async () => {
    if (checkpointLoaded || !checkpointEnabled) return;
    await checkpointStore.load();
    checkpointLoaded = true;
};

const toTaskRunCheckpoint = (
    runId: string,
    workspaceId: string,
    status: RunStatus,
    cursor: number,
): TaskRunCheckpoint => ({
    runId,
    workspaceId,
    status,
    cursor,
    nextSeq: cursor,
    lastAckSeq: Math.max(-1, cursor - 1),
    updatedAt: Date.now(),
});

const persistCheckpoint = async (checkpoint: TaskRunCheckpoint) => {
    if (!checkpointEnabled) return;
    checkpointStore.checkpoints.set(checkpoint.runId, checkpoint);
    await checkpointStore.flush();
};

const getRun = (runId: string) => runs.get(runId) || null;

export const taskStreamHandlers: Record<string, ActionHandler> = {
    'task.run.start': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { workspaceId?: string; runId?: string };
        const workspaceId = payload.workspaceId || action.scope?.workspaceId;
        if (!workspaceId) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing workspaceId');
        }

        const runId = payload.runId || crypto.randomUUID();
        const queue = createStepsQueue();
        const pipe = createResultPipe();
        const signals = createSignalChannel();
        const state: TaskRunState = {
            runId,
            workspaceId,
            status: 'running',
            queue,
            pipe,
            signals,
            checkpoint: { runId, workspaceId, status: 'running', cursor: 0, updatedAt: Date.now() },
        };
        runs.set(runId, state);
        await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceId, 'running', 0));

        void runSteps({
            runId,
            workspaceId,
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: true,
            onCheckpoint: async (checkpoint) => {
                state.checkpoint = checkpoint;
                state.status = checkpoint.status;
                await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceId, checkpoint.status, checkpoint.cursor));
                if (checkpoint.status === 'completed' || checkpoint.status === 'failed' || checkpoint.status === 'halted') {
                    runs.delete(runId);
                }
            },
        })
            .then((checkpoint) => {
                state.checkpoint = checkpoint;
                state.status = checkpoint.status;
            })
            .catch((error) => {
                state.status = 'failed';
                state.checkpoint = {
                    runId,
                    workspaceId,
                    status: 'failed',
                    cursor: state.queue.cursor,
                    updatedAt: Date.now(),
                };
                void persistCheckpoint(toTaskRunCheckpoint(runId, workspaceId, 'failed', state.queue.cursor));
                ctx.log('task.run.error', { runId, error: error instanceof Error ? error.message : String(error) });
            });

        return makeOk({ runId });
    },

    'task.run.push': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string; steps?: StepUnion[]; close?: boolean };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        const steps = Array.isArray(payload.steps) ? payload.steps : [];
        if (steps.length > 0) enqueueSteps(run.queue, steps);
        if (payload.close === true) closeStepsQueue(run.queue);
        return makeOk({ runId: run.runId, queued: steps.length, cursor: run.queue.cursor });
    },

    'task.run.poll': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string; cursor?: number; limit?: number };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        const { items, nextCursor } = readResultPipe(run.pipe, payload.cursor, payload.limit);
        const done = run.status !== 'running' && run.status !== 'suspended' && nextCursor >= run.pipe.items.length;
        return makeOk({ runId: run.runId, items, cursor: nextCursor, done });
    },

    'task.run.checkpoint': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'checkpoint');
        run.checkpoint = {
            runId: run.runId,
            workspaceId: run.workspaceId,
            status: run.status,
            cursor: run.queue.cursor,
            updatedAt: Date.now(),
        };
        await persistCheckpoint(
            toTaskRunCheckpoint(run.runId, run.workspaceId, run.status, run.queue.cursor),
        );
        return makeOk({ checkpoint: run.checkpoint });
    },

    'task.run.halt': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'halt');
        run.status = 'halted';
        runs.delete(run.runId);
        const checkpoint = {
            runId: run.runId,
            workspaceId: run.workspaceId,
            status: 'halted' as const,
            cursor: run.queue.cursor,
            updatedAt: Date.now(),
        };
        await persistCheckpoint(toTaskRunCheckpoint(run.runId, run.workspaceId, 'halted', run.queue.cursor));
        return makeOk({ checkpoint });
    },

    'task.run.suspend': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'suspend');
        return makeOk({ runId: run.runId });
    },

    'task.run.continue': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'continue');
        return makeOk({ runId: run.runId });
    },

    'task.run.flush': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'flush');
        return makeOk({ runId: run.runId, cursor: run.queue.cursor });
    },

    'task.run.resume': async (ctx, action) => {
        await ensureCheckpointLoaded();
        const payload = (action.payload || {}) as { runId?: string; steps?: StepUnion[]; close?: boolean };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        if (getRun(payload.runId)) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run already active');
        }
        const checkpoint = checkpointStore.checkpoints.get(payload.runId);
        if (!checkpoint) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint not found');
        }
        const steps = Array.isArray(payload.steps) ? payload.steps : [];
        if (steps.length > 0 && checkpoint.cursor > steps.length) {
            return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint cursor exceeds provided steps');
        }

        const queue = createStepsQueue(steps, { closed: payload.close === true });
        queue.cursor = checkpoint.cursor;
        const pipe = createResultPipe();
        const signals = createSignalChannel();
        const state: TaskRunState = {
            runId: checkpoint.runId,
            workspaceId: checkpoint.workspaceId,
            status: 'running',
            queue,
            pipe,
            signals,
            checkpoint,
        };
        runs.set(checkpoint.runId, state);
        await persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceId, 'running', checkpoint.cursor));

        void runSteps({
            runId: checkpoint.runId,
            workspaceId: checkpoint.workspaceId,
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: true,
            onCheckpoint: async (next) => {
                state.checkpoint = next;
                state.status = next.status;
                await persistCheckpoint(
                    toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceId, next.status, next.cursor),
                );
                if (next.status === 'completed' || next.status === 'failed' || next.status === 'halted') {
                    runs.delete(checkpoint.runId);
                }
            },
        })
            .then((finalCheckpoint) => {
                state.checkpoint = finalCheckpoint;
                state.status = finalCheckpoint.status;
            })
            .catch((error) => {
                state.status = 'failed';
                state.checkpoint = {
                    runId: checkpoint.runId,
                    workspaceId: checkpoint.workspaceId,
                    status: 'failed',
                    cursor: state.queue.cursor,
                    updatedAt: Date.now(),
                };
                void persistCheckpoint(
                    toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceId, 'failed', state.queue.cursor),
                );
                ctx.log('task.run.resume.error', {
                    runId: checkpoint.runId,
                    error: error instanceof Error ? error.message : String(error),
                });
            });

        return makeOk({
            runId: checkpoint.runId,
            workspaceId: checkpoint.workspaceId,
            checkpoint: state.checkpoint,
            resumed: true,
        });
    },
};
