import crypto from 'node:crypto';
import type { StepResult as ExecStepResult, StepUnion } from './steps/types';
import { runCheckpoint, setCheckpoints } from './checkpoint';
import { getFailedCtx } from './failed_ctx';
import { getLogger } from '../logging/logger';
import {
    markSnapshotSessionDirty,
    shouldMarkSnapshotDirtyByStep,
} from './steps/executors/snapshot/core/session_store';
import type {
    Checkpoint,
    ResultPipe,
    RunSignal,
    RunStatus,
    RunStepsDeps,
    RunStepsRequest,
    SignalChannel,
    StepEvent,
    StepResult,
    StepSink,
    StepsQueue,
} from './run_steps_types';

export type {
    Checkpoint,
    ResultPipe,
    RunSignal,
    RunStatus,
    RunStepsDeps,
    RunStepsRequest,
    SignalChannel,
    StepEvent,
    StepResult,
    StepSink,
    StepsQueue,
} from './run_steps_types';

const stepLogger = getLogger('step');

export class MemoryStepSink implements StepSink {
    events: StepEvent[] = [];
    write(event: StepEvent) {
        this.events.push(event);
    }
}

export const createConsoleStepSink = (prefix = '[step]'): StepSink => ({
    write: (event) => {
        const iso = new Date(event.ts).toISOString();
        if (event.type === 'step.start') {
            stepLogger(
                `${prefix} start ts=${event.ts} iso=${iso} workspace=${event.workspaceId} step=${event.stepId} name=${event.name}`,
            );
            return;
        }
        stepLogger(
            `${prefix} end ts=${event.ts} iso=${iso} workspace=${event.workspaceId} step=${event.stepId} name=${event.name} ok=${event.ok} ms=${event.durationMs}`,
        );
    },
});

let defaultDeps: RunStepsDeps | null = null;

const queueWaiters = new WeakMap<StepsQueue, Set<() => void>>();
const signalWaiters = new WeakMap<SignalChannel, Set<() => void>>();

const getWaiters = <T extends object>(map: WeakMap<T, Set<() => void>>, key: T) => {
    const existing = map.get(key);
    if (existing) {return existing;}
    const created = new Set<() => void>();
    map.set(key, created);
    return created;
};

const notifyAll = (waiters: Set<() => void>) => {
    for (const wake of waiters) {wake();}
    waiters.clear();
};

const writeStepEvent = async (sinks: StepSink[] | undefined, event: StepEvent) => {
    if (!sinks || sinks.length === 0) {return;}
    await Promise.all(sinks.map((sink) => sink.write(event)));
};

const executeOne = async (
    step: StepUnion,
    workspaceId: string,
    deps: RunStepsDeps,
): Promise<ExecStepResult> => {
    const fn = deps.pluginHost.getExecutors()[step.name];
    if (!fn) {
        stepLogger('[runner] missing executor', step.name);
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_NOT_FOUND', message: `executor not found for step: ${step.name}` },
        };
    }
    return await fn(step, deps, workspaceId);
};

const writeRunnerStepResultCache = async (
    deps: RunStepsDeps,
    workspaceId: string,
    runId: string,
    result: ExecStepResult,
) => {
    try {
        const binding = await deps.runtime.ensureActivePage(workspaceId);
        const cache = (binding.traceCtx?.cache || {}) as {
            runnerStepResults?: Record<string, unknown>;
            runnerStepResultsRunId?: string;
        };
        if (cache.runnerStepResultsRunId !== runId) {
            cache.runnerStepResultsRunId = runId;
            cache.runnerStepResults = {};
        }
        cache.runnerStepResults = cache.runnerStepResults || {};
        cache.runnerStepResults[result.stepId] = {
            ok: result.ok,
            data: result.data,
            error: result.error,
        };
    } catch {
        // best effort only
    }
};

const waitForInput = (queue: StepsQueue, signalChannel: SignalChannel) =>
    new Promise<void>((resolve) => {
        getWaiters(queueWaiters, queue).add(resolve);
        getWaiters(signalWaiters, signalChannel).add(resolve);
    });

const checkpointOf = (runId: string, workspaceId: string, status: RunStatus, cursor: number): Checkpoint => ({
    runId,
    workspaceId,
    status,
    cursor,
    updatedAt: Date.now(),
});

export const createStepsQueue = (steps: StepUnion[] = [], opts?: { closed?: boolean }): StepsQueue => ({
    items: [...steps],
    cursor: 0,
    closed: opts?.closed === true,
});

export const enqueueSteps = (queue: StepsQueue, steps: StepUnion[]) => {
    if (queue.closed) {throw new Error('steps queue is closed');}
    if (steps.length === 0) {return;}
    queue.items.push(...steps);
    notifyAll(getWaiters(queueWaiters, queue));
};

export const closeStepsQueue = (queue: StepsQueue) => {
    queue.closed = true;
    notifyAll(getWaiters(queueWaiters, queue));
};

export const createResultPipe = (): ResultPipe => ({ items: [] });

export const readResultPipe = (pipe: ResultPipe, cursor = 0, limit = 100) => {
    const start = cursor >= 0 ? cursor : 0;
    const max = limit > 0 ? limit : 100;
    const items = pipe.items.slice(start, start + max);
    return { items, nextCursor: start + items.length };
};

export const createSignalChannel = (): SignalChannel => ({ items: [], cursor: 0 });

const signalPriority = (signal: RunSignal): number => {
    if (signal === 'halt') {return 100;}
    if (signal === 'flush') {return 80;}
    if (signal === 'suspend') {return 60;}
    if (signal === 'continue') {return 40;}
    return 10;
};

export const sendSignal = (signalChannel: SignalChannel, signal: RunSignal) => {
    const event = { signal, ts: Date.now(), priority: signalPriority(signal) };
    const unreadStart = signalChannel.cursor;
    let insertAt = signalChannel.items.length;
    for (let i = unreadStart; i < signalChannel.items.length; i += 1) {
        const current = signalChannel.items[i];
        if (event.priority > current.priority || (event.priority === current.priority && event.ts < current.ts)) {
            insertAt = i;
            break;
        }
    }
    signalChannel.items.splice(insertAt, 0, event);
    notifyAll(getWaiters(signalWaiters, signalChannel));
};

export const setRunStepsDeps = (deps: RunStepsDeps) => {
    defaultDeps = deps;
};

export const runSteps = async (req: RunStepsRequest, deps?: RunStepsDeps): Promise<Checkpoint> => {
    const resolvedDeps = deps || defaultDeps;
    if (!resolvedDeps) {
        throw new Error('runSteps deps not initialized');
    }

    const stopOnError = req.stopOnError ?? true;
    const checkpointEnabled = req.checkpointEnabled ?? true;
    const checkpointMaxAttempts = req.checkpointMaxAttempts ?? 1;
    const checkpointAttempts = new Map<string, number>();
    let status: RunStatus = 'running';
    setCheckpoints(req.checkpoints || []);

    while (true) {
        while (req.signalChannel.cursor < req.signalChannel.items.length) {
            const event = req.signalChannel.items[req.signalChannel.cursor++];
            if (event.signal === 'halt') {
                status = 'halted';
                const checkpoint = checkpointOf(req.runId, req.workspaceId, status, req.stepsQueue.cursor);
                await req.onCheckpoint?.(checkpoint);
                return checkpoint;
            }
            if (event.signal === 'flush') {
                req.stepsQueue.items.length = req.stepsQueue.cursor;
                continue;
            }
            if (event.signal === 'suspend') {
                status = 'suspended';
                continue;
            }
            if (event.signal === 'continue' && status === 'suspended') {
                status = 'running';
                continue;
            }
        }

        if (status === 'suspended') {
            await waitForInput(req.stepsQueue, req.signalChannel);
            continue;
        }

        if (req.stepsQueue.cursor < req.stepsQueue.items.length) {
            const stepIndex = req.stepsQueue.cursor;
            const step = req.stepsQueue.items[stepIndex];
            req.stepsQueue.cursor += 1;

            const startedAt = Date.now();
            await writeStepEvent(resolvedDeps.stepSinks, {
                type: 'step.start',
                ts: startedAt,
                workspaceId: req.workspaceId,
                stepId: step.id,
                name: step.name,
                argsSummary: step.args,
            });

            const result = await executeOne(step, req.workspaceId, resolvedDeps);
            if (result.ok && shouldMarkSnapshotDirtyByStep(step.name, step.args)) {
                try {
                    const binding = await resolvedDeps.runtime.ensureActivePage(req.workspaceId);
                    markSnapshotSessionDirty(binding, `step:${step.name}`);
                } catch (error) {
                    stepLogger('[runner] snapshot dirty mark failed', {
                        step: step.name,
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            }

            await writeStepEvent(resolvedDeps.stepSinks, {
                type: 'step.end',
                ts: Date.now(),
                workspaceId: req.workspaceId,
                stepId: step.id,
                name: step.name,
                ok: result.ok,
                durationMs: Date.now() - startedAt,
                error: result.ok ? undefined : result.error,
            });

            let finalResult = result;
            let nextStatus: RunStatus | undefined;
            if (!result.ok) {
                const attempt = checkpointAttempts.get(step.id) ?? 0;
                const failedCtx = await getFailedCtx({
                    runId: req.runId,
                    workspaceId: req.workspaceId,
                    stepIndex,
                    step,
                    rawResult: result,
                    stopOnError,
                    checkpointEnabled,
                    checkpointAttempt: attempt,
                    checkpointMaxAttempts,
                    inCheckpointFlow: false,
                    deps: resolvedDeps,
                    executeStep: (nestedStep) => executeOne(nestedStep, req.workspaceId, resolvedDeps),
                    checkpoints: req.checkpoints,
                });
                const checkpointOutput = await runCheckpoint(failedCtx);
                finalResult = checkpointOutput.finalResult;
                nextStatus = checkpointOutput.nextStatus;
                checkpointAttempts.set(step.id, attempt + 1);
            }

            const output: StepResult = {
                runId: req.runId,
                cursor: stepIndex,
                stepId: finalResult.stepId,
                ok: finalResult.ok,
                data: finalResult.data,
                error: finalResult.error,
                ts: Date.now(),
            };
            await writeRunnerStepResultCache(resolvedDeps, req.workspaceId, req.runId, finalResult);
            req.resultPipe.items.push(output);

            if (nextStatus === 'suspended') {
                status = 'suspended';
            } else if (!finalResult.ok && stopOnError) {
                status = 'failed';
            }

            const checkpoint = checkpointOf(req.runId, req.workspaceId, status, req.stepsQueue.cursor);
            await req.onCheckpoint?.(checkpoint);
            if (status === 'failed') {
                return checkpoint;
            }
            continue;
        }

        if (req.stepsQueue.closed) {
            status = 'completed';
            const checkpoint = checkpointOf(req.runId, req.workspaceId, status, req.stepsQueue.cursor);
            await req.onCheckpoint?.(checkpoint);
            return checkpoint;
        }

        await waitForInput(req.stepsQueue, req.signalChannel);
    }
};

export const runStepList = async (
    workspaceId: string,
    steps: StepUnion[],
    deps?: RunStepsDeps,
    opts?: { stopOnError?: boolean; runId?: string },
) => {
    const queue = createStepsQueue(steps, { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps(
        {
            runId: opts?.runId || crypto.randomUUID(),
            workspaceId,
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stopOnError: opts?.stopOnError,
        },
        deps,
    );
    return { checkpoint, pipe };
};
