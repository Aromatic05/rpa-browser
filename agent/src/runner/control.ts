import crypto from 'node:crypto';
import path from 'node:path';
import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceControlInput } from '../runtime/workspace_control';
import type { ControlPlaneResult } from '../runtime/control';
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
} from './run_steps';
import type { StepUnion } from './steps/types';
import { createTaskCheckpointStore, type TaskRunCheckpoint } from './checkpoint_store';
import { getRunnerConfig, type RunnerConfig } from '../config';

type TaskRunState = {
    runId: string;
    workspaceName: string;
    status: RunStatus;
    queue: StepsQueue;
    pipe: ResultPipe;
    signals: SignalChannel;
    checkpoint: Checkpoint;
};

export type RunnerControlDeps = {
    runnerConfig?: RunnerConfig;
};

export type RunnerControl = {
    handle: (input: WorkspaceControlInput) => Promise<ControlPlaneResult>;
};

export const createRunnerControl = (deps?: RunnerControlDeps): RunnerControl => {
    const runnerConfig = deps?.runnerConfig || getRunnerConfig();
    const runtime = {
        runs: new Map<string, TaskRunState>(),
        checkpointStore: createTaskCheckpointStore(
            path.resolve(process.cwd(), runnerConfig.checkpointPolicy.filePath),
            { flushIntervalMs: runnerConfig.checkpointPolicy.flushIntervalMs },
        ),
        checkpointEnabled: runnerConfig.checkpointPolicy.enabled,
        checkpointLoaded: false,
    };

    const ensureCheckpointLoaded = async () => {
        if (runtime.checkpointLoaded || !runtime.checkpointEnabled) {return;}
        await runtime.checkpointStore.load();
        runtime.checkpointLoaded = true;
    };

    const toTaskRunCheckpoint = (
        runId: string,
        workspaceName: string,
        status: RunStatus,
        cursor: number,
    ): TaskRunCheckpoint => ({
        runId,
        workspaceName,
        status,
        cursor,
        nextSeq: cursor,
        lastAckSeq: Math.max(-1, cursor - 1),
        updatedAt: Date.now(),
    });

    const persistCheckpoint = async (checkpoint: TaskRunCheckpoint) => {
        if (!runtime.checkpointEnabled) {return;}
        runtime.checkpointStore.checkpoints.set(checkpoint.runId, checkpoint);
        await runtime.checkpointStore.flush();
    };

    const getRun = (runId: string) => runtime.runs.get(runId) || null;

    const requireRunId = (payload: { runId?: string }): string => {
        if (!payload.runId) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        return payload.runId;
    };

    return {
        handle: async (input) => {
            const { action, workspace } = input;
            await ensureCheckpointLoaded();

            if (!action.type.startsWith('task.run.')) {
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
            }

            if (action.type === 'task.run.start') {
                const payload = (action.payload || {}) as { runId?: string };
                const workspaceName = workspace.name;
                const runId = payload.runId || crypto.randomUUID();
                const queue = createStepsQueue();
                const pipe = createResultPipe();
                const signals = createSignalChannel();
                const state: TaskRunState = {
                    runId,
                    workspaceName,
                    status: 'running',
                    queue,
                    pipe,
                    signals,
                    checkpoint: { runId, workspaceName, status: 'running', cursor: 0, updatedAt: Date.now() },
                };
                runtime.runs.set(runId, state);
                await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceName, 'running', 0));

                void runSteps({
                    runId,
                    workspaceName,
                    stepsQueue: queue,
                    resultPipe: pipe,
                    signalChannel: signals,
                    stopOnError: true,
                    onCheckpoint: async (checkpoint) => {
                        state.checkpoint = checkpoint;
                        state.status = checkpoint.status;
                        await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceName, checkpoint.status, checkpoint.cursor));
                        if (checkpoint.status === 'completed' || checkpoint.status === 'failed' || checkpoint.status === 'halted') {
                            runtime.runs.delete(runId);
                        }
                    },
                })
                    .then((checkpoint) => {
                        state.checkpoint = checkpoint;
                        state.status = checkpoint.status;
                    })
                    .catch(() => {
                        state.status = 'failed';
                        state.checkpoint = {
                            runId,
                            workspaceName,
                            status: 'failed',
                            cursor: state.queue.cursor,
                            updatedAt: Date.now(),
                        };
                        void persistCheckpoint(toTaskRunCheckpoint(runId, workspaceName, 'failed', state.queue.cursor));
                    });

                return { reply: replyAction(action, { runId }), events: [] };
            }

            if (action.type === 'task.run.push') {
                const payload = (action.payload || {}) as { runId?: string; steps?: StepUnion[]; close?: boolean };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                const steps = Array.isArray(payload.steps) ? payload.steps : [];
                if (steps.length > 0) {enqueueSteps(run.queue, steps);}
                if (payload.close === true) {closeStepsQueue(run.queue);}
                return { reply: replyAction(action, { runId: run.runId, queued: steps.length, cursor: run.queue.cursor }), events: [] };
            }

            if (action.type === 'task.run.poll') {
                const payload = (action.payload || {}) as { runId?: string; cursor?: number; limit?: number };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                const { items, nextCursor } = readResultPipe(run.pipe, payload.cursor, payload.limit);
                const done = run.status !== 'running' && run.status !== 'suspended' && nextCursor >= run.pipe.items.length;
                return { reply: replyAction(action, { runId: run.runId, items, cursor: nextCursor, done }), events: [] };
            }

            if (action.type === 'task.run.checkpoint') {
                const payload = (action.payload || {}) as { runId?: string };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                sendSignal(run.signals, 'checkpoint');
                run.checkpoint = { runId: run.runId, workspaceName: run.workspaceName, status: run.status, cursor: run.queue.cursor, updatedAt: Date.now() };
                await persistCheckpoint(toTaskRunCheckpoint(run.runId, run.workspaceName, run.status, run.queue.cursor));
                return { reply: replyAction(action, { checkpoint: run.checkpoint }), events: [] };
            }

            if (action.type === 'task.run.halt') {
                const payload = (action.payload || {}) as { runId?: string };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                sendSignal(run.signals, 'halt');
                run.status = 'halted';
                runtime.runs.delete(run.runId);
                const checkpoint = { runId: run.runId, workspaceName: run.workspaceName, status: 'halted' as const, cursor: run.queue.cursor, updatedAt: Date.now() };
                await persistCheckpoint(toTaskRunCheckpoint(run.runId, run.workspaceName, 'halted', run.queue.cursor));
                return { reply: replyAction(action, { checkpoint }), events: [] };
            }

            if (action.type === 'task.run.suspend') {
                const payload = (action.payload || {}) as { runId?: string };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                sendSignal(run.signals, 'suspend');
                return { reply: replyAction(action, { runId: run.runId }), events: [] };
            }

            if (action.type === 'task.run.continue') {
                const payload = (action.payload || {}) as { runId?: string };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                sendSignal(run.signals, 'continue');
                return { reply: replyAction(action, { runId: run.runId }), events: [] };
            }

            if (action.type === 'task.run.flush') {
                const payload = (action.payload || {}) as { runId?: string };
                const run = getRun(requireRunId(payload));
                if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
                sendSignal(run.signals, 'flush');
                return { reply: replyAction(action, { runId: run.runId, cursor: run.queue.cursor }), events: [] };
            }

            if (action.type === 'task.run.resume') {
                const payload = (action.payload || {}) as { runId?: string; steps?: StepUnion[]; close?: boolean };
                const runId = requireRunId(payload);
                if (getRun(runId)) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run already active');
                }
                const checkpoint = runtime.checkpointStore.checkpoints.get(runId);
                if (!checkpoint) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint not found');
                }
                const steps = Array.isArray(payload.steps) ? payload.steps : [];
                if (steps.length > 0 && checkpoint.cursor > steps.length) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint cursor exceeds provided steps');
                }

                const queue = createStepsQueue(steps, { closed: payload.close === true });
                queue.cursor = checkpoint.cursor;
                const pipe = createResultPipe();
                const signals = createSignalChannel();
                const state: TaskRunState = {
                    runId: checkpoint.runId,
                    workspaceName: checkpoint.workspaceName,
                    status: 'running',
                    queue,
                    pipe,
                    signals,
                    checkpoint,
                };
                runtime.runs.set(checkpoint.runId, state);
                await persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceName, 'running', checkpoint.cursor));

                void runSteps({
                    runId: checkpoint.runId,
                    workspaceName: checkpoint.workspaceName,
                    stepsQueue: queue,
                    resultPipe: pipe,
                    signalChannel: signals,
                    stopOnError: true,
                    onCheckpoint: async (next) => {
                        state.checkpoint = next;
                        state.status = next.status;
                        await persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceName, next.status, next.cursor));
                        if (next.status === 'completed' || next.status === 'failed' || next.status === 'halted') {
                            runtime.runs.delete(checkpoint.runId);
                        }
                    },
                })
                    .then((finalCheckpoint) => {
                        state.checkpoint = finalCheckpoint;
                        state.status = finalCheckpoint.status;
                    })
                    .catch(() => {
                        state.status = 'failed';
                        state.checkpoint = {
                            runId: checkpoint.runId,
                            workspaceName: checkpoint.workspaceName,
                            status: 'failed',
                            cursor: state.queue.cursor,
                            updatedAt: Date.now(),
                        };
                        void persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceName, 'failed', state.queue.cursor));
                    });

                return {
                    reply: replyAction(action, {
                        runId: checkpoint.runId,
                        workspaceName: checkpoint.workspaceName,
                        checkpoint: state.checkpoint,
                        resumed: true,
                    }),
                    events: [],
                };
            }

            throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
        },
    };
};
