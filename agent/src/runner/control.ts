import crypto from 'node:crypto';
import path from 'node:path';
import { replyAction } from '../actions/action_protocol';
import { ActionError } from '../actions/results';
import { ERROR_CODES } from '../actions/results';
import type { WorkspaceRouterInput } from '../runtime/workspace/router';
import type { ControlPlaneResult } from '../runtime/control_plane';
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
import type { StepResolve, StepUnion } from './steps/types';
import type {Checkpoint as RunnerCheckpoint} from './checkpoint';
import { createTaskCheckpointStore, type TaskCheckpointStore, type TaskRunCheckpoint } from './checkpoint_store';
import { getRunnerConfig, type RunnerConfig } from '../config';
import {
    readCheckpointBodies,
    readCheckpoints,
    readCheckpointStepResolves,
    readPollCursor,
    readPollLimit,
    readStepResolves,
    readSteps,
} from './control_input';
import {acquireWorkspaceExecution, type WorkspaceExecutionRelease} from '../runtime/workspace/execution_coordinator';

type TaskRunState = {
    runId: string;
    workspaceName: string;
    status: RunStatus;
    queue: StepsQueue;
    pipe: ResultPipe;
    signals: SignalChannel;
    checkpoint: Checkpoint;
    stepResolves: Record<string, StepResolve>;
    checkpoints: RunnerCheckpoint[];
    checkpointStepResolves: Record<string, Record<string, StepResolve>>;
    checkpointBodies: Record<string, string>;
    completion: Promise<void>;
    executionSettled: () => boolean;
    settleExecution: () => void;
    transition: Promise<void>;
};

export type RunnerControlDeps = {
    runnerConfig?: RunnerConfig;
    checkpointStore?: TaskCheckpointStore;
};

export type RunnerControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
    stop: () => Promise<void>;
};



const assertRunAcceptsPush = (run: TaskRunState): void => {
    if (run.queue.closed || (run.status !== 'running' && run.status !== 'suspended')) {
        throw new ActionError(ERROR_CODES.ERR_BAD_STATE, `run is not accepting steps: ${run.runId}`);
    }
};

const isRunActive = (run: TaskRunState): boolean =>
    run.status === 'running' || run.status === 'suspended';

const assertRunActive = (run: TaskRunState, actionType: string): void => {
    if (!isRunActive(run)) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_STATE,
            `${actionType} requires an active run: ${run.runId} (${run.status})`,
        );
    }
};

const assertRunStatus = (run: TaskRunState, expected: RunStatus, actionType: string): void => {
    if (run.status !== expected) {
        throw new ActionError(
            ERROR_CODES.ERR_BAD_STATE,
            `${actionType} requires run status=${expected}: ${run.runId} (${run.status})`,
        );
    }
};

export const createRunnerControl = (deps?: RunnerControlDeps): RunnerControl => {
    const runnerConfig = deps?.runnerConfig || getRunnerConfig();
    const runtime = {
        runs: new Map<string, TaskRunState>(),
        checkpointStore: deps?.checkpointStore ?? createTaskCheckpointStore(
            path.resolve(process.cwd(), runnerConfig.checkpointPolicy.filePath),
            { flushIntervalMs: runnerConfig.checkpointPolicy.flushIntervalMs },
        ),
        checkpointEnabled: runnerConfig.checkpointPolicy.enabled,
        checkpointLoaded: false,
    };
    let stopped = false;
    let stopping = false;
    let stopPromise: Promise<void> | null = null;

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
        const previous = runtime.checkpointStore.checkpoints.get(checkpoint.runId);
        runtime.checkpointStore.checkpoints.set(checkpoint.runId, checkpoint);
        try {
            await runtime.checkpointStore.flush();
        } catch (error) {
            if (previous) {
                runtime.checkpointStore.checkpoints.set(checkpoint.runId, previous);
            } else {
                runtime.checkpointStore.checkpoints.delete(checkpoint.runId);
            }
            throw error;
        }
    };

    const getRun = (runId: string) => runtime.runs.get(runId) || null;

    const serializeRunTransition = async <T>(
        run: TaskRunState,
        transition: () => Promise<T>,
    ): Promise<T> => {
        const previous = run.transition;
        let release!: () => void;
        run.transition = new Promise<void>((resolve) => {release = resolve;});
        await previous;
        try {
            return await transition();
        } finally {
            release();
        }
    };

    const createRunExecutionLifecycle = (
        releaseExecution: WorkspaceExecutionRelease,
    ): Pick<TaskRunState, 'completion' | 'executionSettled' | 'settleExecution'> => {
        let resolveCompletion!: () => void;
        let settled = false;
        const completion = new Promise<void>((resolve) => {resolveCompletion = resolve;});
        return {
            completion,
            executionSettled: () => settled,
            settleExecution: () => {
                if (settled) {return;}
                settled = true;
                releaseExecution();
                resolveCompletion();
            },
        };
    };

    const requireRunId = (payload: {runId?: unknown}): string => {
        if (typeof payload.runId !== 'string') {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'missing runId');
        }
        if (payload.runId.length === 0 || payload.runId !== payload.runId.trim() || payload.runId.length > 128) {
            throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'invalid runId');
        }
        return payload.runId;
    };

    const requireOwnedRun = (
        payload: {runId?: unknown},
        workspaceName: string,
    ): TaskRunState => {
        const run = getRun(requireRunId(payload));
        if (!run) {throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run not found');}
        if (run.workspaceName !== workspaceName) {
            throw new ActionError(ERROR_CODES.ERR_CONFLICT, 'run belongs to another workspace');
        }
        return run;
    };

    const haltedCheckpoint = (run: TaskRunState): Checkpoint => ({
        runId: run.runId,
        workspaceName: run.workspaceName,
        status: 'halted',
        cursor: run.queue.cursor,
        updatedAt: Date.now(),
    });

    const observeCheckpoint = async (run: TaskRunState, checkpoint: Checkpoint): Promise<void> => {
        await serializeRunTransition(run, async () => {
            if (stopped) {
                const halted = haltedCheckpoint(run);
                run.checkpoint = halted;
                run.status = 'halted';
                return;
            }
            if (stopping) {
                run.checkpoint = checkpoint;
                run.status = checkpoint.status;
                return;
            }
            run.checkpoint = checkpoint;
            run.status = checkpoint.status;
            await persistCheckpoint(toTaskRunCheckpoint(
                run.runId,
                run.workspaceName,
                checkpoint.status,
                checkpoint.cursor,
            ));
        });
    };

    const stop = async (): Promise<void> => {
        if (stopped) {return;}
        if (stopPromise) {
            await stopPromise;
            return;
        }
        stopping = true;
        stopPromise = (async () => {
            const runs = [...runtime.runs.values()];
            const activeRuns = runs.filter(isRunActive);
            await Promise.all(activeRuns.map(async (run) => {
                await persistCheckpoint(toTaskRunCheckpoint(
                    run.runId,
                    run.workspaceName,
                    'halted',
                    run.queue.cursor,
                ));
            }));
            for (const run of activeRuns) {
                const checkpoint = haltedCheckpoint(run);
                run.checkpoint = checkpoint;
                run.status = 'halted';
                sendSignal(run.signals, 'halt');
                closeStepsQueue(run.queue);
            }
            await Promise.all(runs.map(async (run) => {
                await run.completion;
            }));
            runtime.runs.clear();
            runtime.checkpointStore.stop();
            stopped = true;
        })();
        try {
            await stopPromise;
        } catch (error) {
            stopping = false;
            stopPromise = null;
            throw error;
        } finally {
            stopping = false;
        }
    };

    return {
        stop,
        handle: async (input) => {
            const { action, workspace } = input;
            if (stopping || stopped) {
                throw new ActionError(ERROR_CODES.ERR_BAD_STATE, 'runner control is stopped');
            }
            await ensureCheckpointLoaded();

            if (!action.type.startsWith('task.run.')) {
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
            }

            if (action.type === 'task.run.start') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                    checkpointStepResolves?: Record<string, Record<string, StepResolve>>;
                    checkpointBodies?: Record<string, string>;
                };
                const workspaceName = workspace.name;
                const runId = payload.runId === undefined ? crypto.randomUUID() : requireRunId(payload);
                if (getRun(runId) || runtime.checkpointStore.checkpoints.has(runId)) {
                    throw new ActionError(ERROR_CODES.ERR_CONFLICT, `run identity already exists: ${runId}`);
                }
                const stepResolves = readStepResolves(payload.stepResolves);
                const checkpoints = readCheckpoints(payload.checkpoints);
                const checkpointStepResolves = readCheckpointStepResolves(payload.checkpointStepResolves);
                const checkpointBodies = readCheckpointBodies(payload.checkpointBodies);
                const releaseExecution = acquireWorkspaceExecution(workspace, action.type);
                const executionLifecycle = createRunExecutionLifecycle(releaseExecution);
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
                    stepResolves,
                    checkpoints,
                    checkpointStepResolves,
                    checkpointBodies,
                    ...executionLifecycle,
                    transition: Promise.resolve(),
                };
                runtime.runs.set(runId, state);
                try {
                    await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceName, 'running', 0));
                } catch (error) {
                    runtime.runs.delete(runId);
                    state.settleExecution();
                    throw error;
                }

                void runSteps({
                    runId,
                    workspaceName,
                    stepsQueue: queue,
                    resultPipe: pipe,
                    signalChannel: signals,
                    stepResolves: state.stepResolves,
                    checkpoints: state.checkpoints,
                    checkpointStepResolves: state.checkpointStepResolves,
                    checkpointBodies: state.checkpointBodies,
                    stopOnError: true,
                    onCheckpoint: async (checkpoint) => {
                        await observeCheckpoint(state, checkpoint);
                    },
                })
                    .then((checkpoint) => {
                        if (stopping || stopped) {return;}
                        state.checkpoint = checkpoint;
                        state.status = checkpoint.status;
                    })
                    .catch(async () => {
                        if (stopping || stopped) {
                            const halted = haltedCheckpoint(state);
                            state.status = 'halted';
                            state.checkpoint = halted;
                            return;
                        }
                        state.status = 'failed';
                        state.checkpoint = {
                            runId,
                            workspaceName,
                            status: 'failed',
                            cursor: state.queue.cursor,
                            updatedAt: Date.now(),
                        };
                        await persistCheckpoint(toTaskRunCheckpoint(runId, workspaceName, 'failed', state.queue.cursor));
                    })
                    .finally(() => {state.settleExecution();});

                return { reply: replyAction(action, { runId }), events: [] };
            }

            if (action.type === 'task.run.push') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    steps?: StepUnion[];
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                    checkpointStepResolves?: Record<string, Record<string, StepResolve>>;
                    checkpointBodies?: Record<string, string>;
                    close?: boolean;
                };
                const run = requireOwnedRun(payload, workspace.name);
                if (payload.checkpoints !== undefined
                    || payload.checkpointStepResolves !== undefined
                    || payload.checkpointBodies !== undefined) {
                    throw new ActionError(
                        ERROR_CODES.ERR_BAD_ARGS,
                        'checkpoint assets must be provided by task.run.start or task.run.resume',
                    );
                }
                const steps = readSteps(payload.steps);
                assertRunAcceptsPush(run);
                Object.assign(run.stepResolves, readStepResolves(payload.stepResolves));
                if (steps.length > 0) {enqueueSteps(run.queue, steps);}
                if (payload.close === true) {closeStepsQueue(run.queue);}
                return { reply: replyAction(action, { runId: run.runId, queued: steps.length, cursor: run.queue.cursor }), events: [] };
            }

            if (action.type === 'task.run.poll') {
                const payload = (action.payload || {}) as { runId?: string; cursor?: number; limit?: number };
                const run = requireOwnedRun(payload, workspace.name);
                const cursor = readPollCursor(payload.cursor, run.pipe.items.length);
                const limit = readPollLimit(payload.limit);
                const { items, nextCursor } = readResultPipe(run.pipe, cursor, limit);
                const done = run.status !== 'running' && run.status !== 'suspended' && nextCursor >= run.pipe.items.length;
                if (done) {runtime.runs.delete(run.runId);}
                return { reply: replyAction(action, { runId: run.runId, items, cursor: nextCursor, done }), events: [] };
            }

            if (action.type === 'task.run.checkpoint') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                };
                const run = requireOwnedRun(payload, workspace.name);
                sendSignal(run.signals, 'checkpoint');
                run.checkpoint = { runId: run.runId, workspaceName: run.workspaceName, status: run.status, cursor: run.queue.cursor, updatedAt: Date.now() };
                await persistCheckpoint(toTaskRunCheckpoint(run.runId, run.workspaceName, run.status, run.queue.cursor));
                return { reply: replyAction(action, { checkpoint: run.checkpoint }), events: [] };
            }

            if (action.type === 'task.run.halt') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                };
                const run = requireOwnedRun(payload, workspace.name);
                if (run.status === 'completed' && !run.executionSettled()) {
                    await run.completion;
                    runtime.runs.delete(run.runId);
                    return { reply: replyAction(action, { checkpoint: run.checkpoint }), events: [] };
                }
                const checkpoint = await serializeRunTransition(run, async () => {
                    assertRunActive(run, action.type);
                    const halted = {
                        runId: run.runId,
                        workspaceName: run.workspaceName,
                        status: 'halted' as const,
                        cursor: run.queue.cursor,
                        updatedAt: Date.now(),
                    };
                    await persistCheckpoint(toTaskRunCheckpoint(run.runId, run.workspaceName, 'halted', run.queue.cursor));
                    sendSignal(run.signals, 'halt');
                    run.status = 'halted';
                    run.checkpoint = halted;
                    return halted;
                });
                await run.completion;
                runtime.runs.delete(run.runId);
                return { reply: replyAction(action, { checkpoint }), events: [] };
            }

            if (action.type === 'task.run.suspend') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                };
                const run = requireOwnedRun(payload, workspace.name);
                assertRunStatus(run, 'running', action.type);
                sendSignal(run.signals, 'suspend');
                return { reply: replyAction(action, { runId: run.runId }), events: [] };
            }

            if (action.type === 'task.run.continue') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                };
                const run = requireOwnedRun(payload, workspace.name);
                assertRunStatus(run, 'suspended', action.type);
                sendSignal(run.signals, 'continue');
                return { reply: replyAction(action, { runId: run.runId }), events: [] };
            }

            if (action.type === 'task.run.flush') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                };
                const run = requireOwnedRun(payload, workspace.name);
                assertRunActive(run, action.type);
                sendSignal(run.signals, 'flush');
                return { reply: replyAction(action, { runId: run.runId, cursor: run.queue.cursor }), events: [] };
            }

            if (action.type === 'task.run.resume') {
                const payload = (action.payload || {}) as {
                    runId?: string;
                    steps?: StepUnion[];
                    stepResolves?: Record<string, StepResolve>;
                    checkpoints?: RunnerCheckpoint[];
                    checkpointStepResolves?: Record<string, Record<string, StepResolve>>;
                    checkpointBodies?: Record<string, string>;
                    close?: boolean;
                };
                const runId = requireRunId(payload);
                if (getRun(runId)) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'run already active');
                }
                const checkpoint = runtime.checkpointStore.checkpoints.get(runId);
                if (!checkpoint) {
                    throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'checkpoint not found');
                }
                if (checkpoint.workspaceName !== workspace.name) {
                    throw new ActionError(ERROR_CODES.ERR_CONFLICT, 'run belongs to another workspace');
                }
                if (checkpoint.status === 'completed' || checkpoint.status === 'halted') {
                    throw new ActionError(
                        ERROR_CODES.ERR_BAD_STATE,
                        `terminal run cannot be resumed: ${runId} (${checkpoint.status})`,
                    );
                }
                const steps = readSteps(payload.steps);
                if (payload.close === true && checkpoint.cursor > steps.length) {
                    throw new ActionError(
                        ERROR_CODES.ERR_BAD_ARGS,
                        'closed resume does not include enough step history for the checkpoint cursor',
                    );
                }
                const stepResolves = readStepResolves(payload.stepResolves);
                const checkpoints = readCheckpoints(payload.checkpoints);
                const checkpointStepResolves = readCheckpointStepResolves(payload.checkpointStepResolves);
                const checkpointBodies = readCheckpointBodies(payload.checkpointBodies);
                const releaseExecution = acquireWorkspaceExecution(workspace, action.type);
                const executionLifecycle = createRunExecutionLifecycle(releaseExecution);

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
                    stepResolves,
                    checkpoints,
                    checkpointStepResolves,
                    checkpointBodies,
                    ...executionLifecycle,
                    transition: Promise.resolve(),
                };
                runtime.runs.set(checkpoint.runId, state);
                try {
                    await persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceName, 'running', checkpoint.cursor));
                } catch (error) {
                    runtime.runs.delete(checkpoint.runId);
                    state.settleExecution();
                    throw error;
                }

                void runSteps({
                    runId: checkpoint.runId,
                    workspaceName: checkpoint.workspaceName,
                    stepsQueue: queue,
                    resultPipe: pipe,
                    signalChannel: signals,
                    stepResolves: state.stepResolves,
                    checkpoints: state.checkpoints,
                    checkpointStepResolves: state.checkpointStepResolves,
                    checkpointBodies: state.checkpointBodies,
                    stopOnError: true,
                    onCheckpoint: async (next) => {
                        await observeCheckpoint(state, next);
                    },
                })
                    .then((finalCheckpoint) => {
                        if (stopping || stopped) {return;}
                        state.checkpoint = finalCheckpoint;
                        state.status = finalCheckpoint.status;
                    })
                    .catch(async () => {
                        if (stopping || stopped) {
                            const halted = haltedCheckpoint(state);
                            state.status = 'halted';
                            state.checkpoint = halted;
                            return;
                        }
                        state.status = 'failed';
                        state.checkpoint = {
                            runId: checkpoint.runId,
                            workspaceName: checkpoint.workspaceName,
                            status: 'failed',
                            cursor: state.queue.cursor,
                            updatedAt: Date.now(),
                        };
                        await persistCheckpoint(toTaskRunCheckpoint(checkpoint.runId, checkpoint.workspaceName, 'failed', state.queue.cursor));
                    })
                    .finally(() => {state.settleExecution();});

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
