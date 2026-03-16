import crypto from 'node:crypto';
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

const getRun = (runId: string) => runs.get(runId) || null;

export const taskStreamHandlers: Record<string, ActionHandler> = {
    'task.run.start': async (ctx, action) => {
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
            checkpoint: { runId, status: 'running', cursor: 0, updatedAt: Date.now() },
        };
        runs.set(runId, state);

        void runSteps({ runId, workspaceId, stepsQueue: queue, resultPipe: pipe, signalChannel: signals, stopOnError: true })
            .then((checkpoint) => {
                state.checkpoint = checkpoint;
                state.status = checkpoint.status;
            })
            .catch((error) => {
                state.status = 'failed';
                state.checkpoint = {
                    runId,
                    status: 'failed',
                    cursor: state.queue.cursor,
                    updatedAt: Date.now(),
                };
                ctx.log('task.run.error', { runId, error: error instanceof Error ? error.message : String(error) });
            });

        return makeOk({ runId });
    },

    'task.run.push': async (ctx, action) => {
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
        const payload = (action.payload || {}) as { runId?: string; cursor?: number; limit?: number };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        const { items, nextCursor } = readResultPipe(run.pipe, payload.cursor, payload.limit);
        const done = run.status !== 'running' && run.status !== 'suspended' && nextCursor >= run.pipe.items.length;
        return makeOk({ runId: run.runId, items, cursor: nextCursor, done });
    },

    'task.run.checkpoint': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'checkpoint');
        run.checkpoint = {
            runId: run.runId,
            status: run.status,
            cursor: run.queue.cursor,
            updatedAt: Date.now(),
        };
        return makeOk({ checkpoint: run.checkpoint });
    },

    'task.run.halt': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'halt');
        return makeOk({ checkpoint: { runId: run.runId, status: 'halted', cursor: run.queue.cursor, updatedAt: Date.now() } });
    },

    'task.run.suspend': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'suspend');
        return makeOk({ runId: run.runId });
    },

    'task.run.continue': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'continue');
        return makeOk({ runId: run.runId });
    },

    'task.run.flush': async (ctx, action) => {
        const payload = (action.payload || {}) as { runId?: string };
        if (!payload.runId) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        const run = getRun(payload.runId);
        if (!run) return makeErr(ERROR_CODES.ERR_BAD_ARGS, 'run not found');
        sendSignal(run.signals, 'flush');
        return makeOk({ runId: run.runId, cursor: run.queue.cursor });
    },
};
