import crypto from 'node:crypto';
import type { StepResult as ExecStepResult, StepUnion } from './steps/types';
import { validateCheckpointFileForSerialization } from './serialization/types';
import { resolveStepArgsRefs } from './step_refs';
import { isAutomaticRecoveryCheckpoint, runCheckpoint, materializeReferencedCheckpointRuntimeSnapshot, type Checkpoint as RunnerCheckpoint } from './checkpoint';
import { getFailedCtx } from './failed_ctx';
import { getLogger } from '../../platform/logging/logger';
import {shouldMarkPageSessionDirtyByStep} from './session';
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
import type { StepResolve } from './steps/types';
import { injectStepResolve } from './step_resolve';
import type { DslCheckpointProvider } from '../../program/dsl/emit';
import type { DslEntityRulesResolver, DslResolveResolver } from '../../program/dsl/link';
import type { Workflow } from '../workflow';
import { resolveStepEntityRulesExecution } from '../snapshot/rules/runtime';
import { summarizeStepArgs } from './step_event_summary';

export type {
    Checkpoint,
    ResultPipe,
    RunSignal,
    RunStatus,
    RunStepsDeps,
    RunStepsExecutionContext,
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
    write(event: StepEvent): void {
        this.events.push(event);
    }
}

export const createConsoleStepSink = (prefix = '[step]'): StepSink => ({
    write: (event) => {
        const iso = new Date(event.ts).toISOString();
        if (event.type === 'step.start') {
            stepLogger(
                `${prefix} start ts=${event.ts} iso=${iso} workspace=${event.workspaceName} step=${event.stepId} name=${event.name}`,
            );
            return;
        }
        stepLogger(
            `${prefix} end ts=${event.ts} iso=${iso} workspace=${event.workspaceName} step=${event.stepId} name=${event.name} ok=${event.ok} ms=${event.durationMs}`,
        );
    },
});

let defaultDeps: RunStepsDeps | null = null;

const queueWaiters = new WeakMap<StepsQueue, Set<() => void>>();
const signalWaiters = new WeakMap<SignalChannel, Set<() => void>>();

const getWaiters = <T extends object>(map: WeakMap<T, Set<() => void>>, key: T): Set<() => void> => {
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
    const results = await Promise.allSettled(
        sinks.map(async (sink) => {await sink.write(event);}),
    );
    for (const result of results) {
        if (result.status !== 'rejected') {continue;}
        try {
            stepLogger('[runner] step sink write failed', {
                eventType: event.type,
                stepId: event.stepId,
                error: result.reason instanceof Error ? result.reason.message : String(result.reason),
            });
        } catch {
            // Observability failures must never alter execution.
        }
    }
};

export type RunLocalStepResults = Record<
    string,
    {
        ok: boolean;
        data?: unknown;
        error?: unknown;
    }
>;

export type ExecuteStepRuntimeOptions = {
    runLocalStepResults?: RunLocalStepResults;
    stepResolves?: Record<string, StepResolve>;
    checkpointProvider?: DslCheckpointProvider;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
};

export const executeStepWithRuntimeContracts = async (
    step: StepUnion,
    workspaceName: string,
    deps: RunStepsDeps,
    options: ExecuteStepRuntimeOptions = {},
): Promise<ExecStepResult> => {
    const runLocalStepResults = options.runLocalStepResults ?? {};
    const executors = deps.pluginHost.getExecutors();
    if (!Object.prototype.hasOwnProperty.call(executors, step.name)) {
        stepLogger('[runner] missing executor', step.name);
        return {
            stepId: step.id,
            ok: false,
            error: { code: 'ERR_NOT_FOUND', message: `executor not found for step: ${step.name}` },
        };
    }
    const resolvedStep = resolveStepArgsRefs(step, {
        getResult: (stepId) => {
            if (!Object.prototype.hasOwnProperty.call(runLocalStepResults, stepId)) {
                return undefined;
            }
            return runLocalStepResults[stepId];
        },
    });
    if (!resolvedStep.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: resolvedStep.error,
        };
    }

    const runtimeStep = injectStepResolve(resolvedStep.step, options.stepResolves);
    if (!runtimeStep.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: runtimeStep.error,
        };
    }

    const entityRules = resolveStepEntityRulesExecution(
        runtimeStep.step.entityRules,
        deps.config.entityRules,
        deps.resolveEntityRulesProvider?.(workspaceName),
    );
    if (entityRules.status === 'invalid') {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_BAD_ARGS',
                message: `step ${step.id} has invalid entityRules control`,
                details: { stepId: step.id, reason: entityRules.reason },
            },
        };
    }
    if (entityRules.status === 'unavailable') {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: `entity_rules provider is unavailable for step ${step.id}`,
                details: {
                    stepId: step.id,
                    stepName: step.name,
                    selection: entityRules.selection,
                    profiles: entityRules.profiles,
                    strict: entityRules.strict,
                    reason: entityRules.reason,
                },
            },
        };
    }

    const fn = executors[step.name];
    const result = await fn(runtimeStep.step, deps, workspaceName, {
        checkpointProvider: options.checkpointProvider,
        entityRulesResolver: options.entityRulesResolver,
        resolveResolver: options.resolveResolver,
    });
    if (result.ok && shouldMarkPageSessionDirtyByStep(runtimeStep.step.name, runtimeStep.step.args)) {
        await markPageSessionDirtyAfterStep(deps, workspaceName, runtimeStep.step);
    }
    return result;
};

const executeOne = async (
    step: StepUnion,
    workspaceName: string,
    runLocalStepResults: RunLocalStepResults,
    deps: RunStepsDeps,
    stepResolves?: Record<string, StepResolve>,
    checkpointProvider?: DslCheckpointProvider,
    entityRulesResolver?: DslEntityRulesResolver,
    resolveResolver?: DslResolveResolver,
): Promise<ExecStepResult> => await executeStepWithRuntimeContracts(step, workspaceName, deps, {
    runLocalStepResults,
    stepResolves,
    checkpointProvider,
    entityRulesResolver,
    resolveResolver,
});

const markPageSessionDirtyAfterStep = async (
    deps: RunStepsDeps,
    workspaceName: string,
    step: StepUnion,
): Promise<void> => {
    try {
        const workspace = deps.resolveWorkspace(workspaceName);
        const tabName = workspace.tabs.getActiveTab()?.name;
        if (!tabName) {
            throw new Error(`active tab not found: ${workspaceName}`);
        }
        const binding = await deps.runtime.awaitExecutableTab({
            workspace,
            pageRegistry: workspace.browserSession.pageRegistry,
            tabName,
            timeoutMs: deps.config.waitPolicy.pageReadyTimeoutMs,
        });
        deps.pageSession.markDirty(binding.page, 'interaction');
    } catch (error) {
        stepLogger('[runner] snapshot dirty mark failed', {
            step: step.name,
            error: error instanceof Error ? error.message : String(error),
        });
    }
};


const writeRunnerStepResultCache = async (
    deps: RunStepsDeps,
    workspaceName: string,
    runId: string,
    result: ExecStepResult,
) => {
    try {
        const workspace = deps.resolveWorkspace(workspaceName);
        const tabName = workspace.tabs.getActiveTab()?.name;
        if (!tabName) {return;}
        const binding = await deps.runtime.awaitExecutableTab({
            workspace,
            pageRegistry: workspace.browserSession.pageRegistry,
            tabName,
            timeoutMs: deps.config.waitPolicy.pageReadyTimeoutMs,
        });
        const cache = binding.traceCtx.cache as {
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

const waitForInput = (queue: StepsQueue, signalChannel: SignalChannel): Promise<void> =>
    new Promise<void>((resolve) => {
        getWaiters(queueWaiters, queue).add(resolve);
        getWaiters(signalWaiters, signalChannel).add(resolve);
    });

const checkpointOf = (runId: string, workspaceName: string, status: RunStatus, cursor: number): Checkpoint => ({
    runId,
    workspaceName,
    status,
    cursor,
    updatedAt: Date.now(),
});

export const createStepsQueue = (steps: StepUnion[] = [], opts?: { closed?: boolean }): StepsQueue => ({
    items: [...steps],
    cursor: 0,
    closed: opts?.closed === true,
});

export const enqueueSteps = (queue: StepsQueue, steps: StepUnion[]): void => {
    if (queue.closed) {throw new Error('steps queue is closed');}
    if (steps.length === 0) {return;}
    queue.items.push(...steps);
    notifyAll(getWaiters(queueWaiters, queue));
};

export const closeStepsQueue = (queue: StepsQueue): void => {
    queue.closed = true;
    notifyAll(getWaiters(queueWaiters, queue));
};

export const createResultPipe = (): ResultPipe => ({ items: [], waiters: new Set(), closed: false });

export const closeResultPipe = (pipe: ResultPipe): void => {
    pipe.closed = true;
    const waiters = [...pipe.waiters];
    pipe.waiters.clear();
    for (const wake of waiters) {wake();}
};

export const readResultPipe = (pipe: ResultPipe, cursor = 0, limit = 100): { items: StepResult[]; nextCursor: number } => {
    const start = cursor >= 0 ? cursor : 0;
    const max = limit > 0 ? limit : 100;
    const items = pipe.items.slice(start, start + max);
    return { items, nextCursor: start + items.length };
};

export const pushResultPipe = (pipe: ResultPipe, result: StepResult): void => {
    pipe.items.push(result);
    const waiters = [...pipe.waiters];
    pipe.waiters.clear();
    for (const wake of waiters) {
        wake();
    }
};

export const waitForResultPipe = async (pipe: ResultPipe): Promise<void> =>
    { if (pipe.closed) {return;} await new Promise<void>((resolve) => {
        pipe.waiters.add(resolve);
    }); };

export const createSignalChannel = (): SignalChannel => ({ items: [], cursor: 0 });

const signalPriority = (signal: RunSignal): number => {
    if (signal === 'halt') {return 100;}
    if (signal === 'flush') {return 80;}
    if (signal === 'suspend') {return 60;}
    if (signal === 'continue') {return 40;}
    return 10;
};

export const sendSignal = (signalChannel: SignalChannel, signal: RunSignal): void => {
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

export const setRunStepsDeps = (deps: RunStepsDeps): void => {
    defaultDeps = deps;
};

const resolveRunCheckpoints = (
    req: RunStepsRequest,
    deps: RunStepsDeps,
): {checkpoints: RunnerCheckpoint[]; stepResolves: Record<string, Record<string, StepResolve>>; bodies: Record<string, string>; provider: DslCheckpointProvider; entityRulesResolver?: DslEntityRulesResolver; resolveResolver?: DslResolveResolver} => {
    if (req.checkpoints !== undefined) {
        validateCheckpointFileForSerialization({version: 1, checkpoints: req.checkpoints});
    }
    const workspace = deps.resolveWorkspace(req.workspaceName);
    const checkpointProviderHost = workspace as unknown as {checkpoint?: {getProvider: (workflow: Workflow) => DslCheckpointProvider}; workflow?: Workflow};
    const sourceProvider = req.checkpoints === undefined && checkpointProviderHost.checkpoint && checkpointProviderHost.workflow
        ? checkpointProviderHost.checkpoint.getProvider(checkpointProviderHost.workflow)
        : undefined;
    const allCheckpoints = req.checkpoints ?? sourceProvider?.listCheckpoints?.() ?? [];
    const stepResolves = req.checkpoints === undefined
        ? Object.fromEntries(allCheckpoints.map((checkpoint) => [
            checkpoint.id,
            sourceProvider?.getCheckpointResolves?.(checkpoint.id) ?? {},
        ]))
        : req.checkpointStepResolves ?? {};
    const bodies = req.checkpoints === undefined
        ? Object.fromEntries(allCheckpoints
            .flatMap((checkpoint) => {
            const body = sourceProvider?.getCheckpointBody?.(checkpoint.id);
            return body ? [[checkpoint.id, body.source] as const] : [];
        }))
        : req.checkpointBodies ?? {};
    const recoverySources = allCheckpoints
        .filter(isAutomaticRecoveryCheckpoint)
        .flatMap((checkpoint) => (bodies as Record<string, string | undefined>)[checkpoint.id] === undefined ? [] : [bodies[checkpoint.id]]);
    const queuedProcedureSources = req.stepsQueue.items
        .slice(req.stepsQueue.cursor)
        .flatMap((step) => {
            if (step.name !== 'browser.checkpoint') {return [];}
            const checkpointId = (step.args as {checkpointId?: unknown}).checkpointId;
            return typeof checkpointId === 'string' && (bodies as Record<string, string | undefined>)[checkpointId] !== undefined
                ? [bodies[checkpointId]]
                : [];
        });
    const snapshot = materializeReferencedCheckpointRuntimeSnapshot({
        sources: [...recoverySources, ...queuedProcedureSources], checkpointProvider: sourceProvider || {
            getCheckpoint: (id) => allCheckpoints.find((checkpoint) => checkpoint.id === id) || null,
            getCheckpointResolves: (id) => (stepResolves as Record<string, Record<string, StepResolve> | undefined>)[id] || null,
            getCheckpointBody: (id) => (bodies as Record<string, string | undefined>)[id] === undefined ? null : {source: bodies[id], stepResolves: (stepResolves as Record<string, Record<string, StepResolve> | undefined>)[id] || {}},
        },
        checkpoints: allCheckpoints, checkpointStepResolves: stepResolves, checkpointBodies: bodies,
        workflow: isWorkflow(workspace.workflow) ? workspace.workflow : undefined,
        entityRulesProvider: deps.resolveEntityRulesProvider?.(req.workspaceName),
    });
    const checkpoints = snapshot.provider.listCheckpoints!()
        .filter(isAutomaticRecoveryCheckpoint);
    return {
        checkpoints,
        stepResolves: snapshot.checkpointStepResolves,
        bodies: snapshot.checkpointBodies,
        provider: snapshot.provider,
        entityRulesResolver: snapshot.entityRulesResolver,
        resolveResolver: snapshot.resolveResolver,
    };
};

const isWorkflow = (value: unknown): value is Workflow =>
    Boolean(value && typeof value === 'object' && 'list' in value && 'get' in value);

const requireCheckpointMaxAttempts = (value: number | undefined): number => {
    if (value === undefined) {return Number.MAX_SAFE_INTEGER;}
    const resolved = value;
    if (!Number.isSafeInteger(resolved) || resolved < 0) {
        throw new Error('checkpointMaxAttempts must be a non-negative finite integer');
    }
    return resolved;
};

export const runSteps = async (req: RunStepsRequest, deps?: RunStepsDeps): Promise<Checkpoint> => {
    const resolvedDeps = deps || defaultDeps;
    const stopOnError = req.stopOnError ?? true;
    const checkpointEnabled = req.checkpointEnabled ?? true;
    const runLocalStepResults: RunLocalStepResults = {};
    let status: RunStatus = 'running';
    let activeStep: StepUnion | undefined;
    let activeCursor = req.stepsQueue.cursor;
    let activeResultPublished = false;
    let checkpointRuntime: ReturnType<typeof resolveRunCheckpoints> | undefined;

    const finish = async (finalStatus: RunStatus): Promise<Checkpoint> => {
        const checkpoint = checkpointOf(req.runId, req.workspaceName, finalStatus, req.stepsQueue.cursor);
        await req.onCheckpoint?.(checkpoint);
        closeStepsQueue(req.stepsQueue);
        closeResultPipe(req.resultPipe);
        return checkpoint;
    };

    const fail = async (error: unknown): Promise<Checkpoint> => {
        const message = error instanceof Error ? error.message : String(error);
        if (activeStep && !activeResultPublished) {
            pushResultPipe(req.resultPipe, {
                runId: req.runId,
                cursor: activeCursor,
                stepId: activeStep.id,
                ok: false,
                error: { code: 'ERR_RUNNER_UNEXPECTED', message },
                ts: Date.now(),
            });
        }
        const checkpoint = checkpointOf(req.runId, req.workspaceName, 'failed', req.stepsQueue.cursor);
        try {
            await req.onCheckpoint?.(checkpoint);
        } catch {
            // The terminal state must still be observable through the return value and closed pipes.
        } finally {
            closeStepsQueue(req.stepsQueue);
            closeResultPipe(req.resultPipe);
        }
        return checkpoint;
    };

    try {
        if (!resolvedDeps) {
            throw new Error('runSteps deps not initialized');
        }
        const checkpointMaxAttempts = requireCheckpointMaxAttempts(req.checkpointMaxAttempts);
        checkpointRuntime = resolveRunCheckpoints(req, resolvedDeps);
        while (true) {
        while (req.signalChannel.cursor < req.signalChannel.items.length) {
            const event = req.signalChannel.items[req.signalChannel.cursor++];
            if (event.signal === 'halt') {
                status = 'halted';
                return await finish(status);
            }
            if (event.signal === 'flush') {
                req.stepsQueue.items.length = req.stepsQueue.cursor;
                continue;
            }
            if (event.signal === 'suspend') {
                status = 'suspended';
                await req.onCheckpoint?.(checkpointOf(
                    req.runId,
                    req.workspaceName,
                    status,
                    req.stepsQueue.cursor,
                ));
                continue;
            }
            if (event.signal === 'continue' && status === 'suspended') {
                status = 'running';
                await req.onCheckpoint?.(checkpointOf(
                    req.runId,
                    req.workspaceName,
                    status,
                    req.stepsQueue.cursor,
                ));
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
            activeStep = step;
            activeCursor = stepIndex;
            activeResultPublished = false;

            const startedAt = Date.now();
            await writeStepEvent(resolvedDeps.stepSinks, {
                type: 'step.start',
                ts: startedAt,
                workspaceName: req.workspaceName,
                stepId: step.id,
                name: step.name,
                argsSummary: summarizeStepArgs(step),
            });

            const result = await executeOne(
                step,
                req.workspaceName,
                runLocalStepResults,
                resolvedDeps,
                req.stepResolves,
                checkpointRuntime.provider,
                checkpointRuntime.entityRulesResolver,
                checkpointRuntime.resolveResolver,
            );

            await writeStepEvent(resolvedDeps.stepSinks, {
                type: 'step.end',
                ts: Date.now(),
                workspaceName: req.workspaceName,
                stepId: step.id,
                name: step.name,
                ok: result.ok,
                durationMs: Date.now() - startedAt,
                error: result.ok ? undefined : result.error,
            });

            let finalResult = result;
            let nextStatus: RunStatus | undefined;
            if (!result.ok) {
                const checkpointAttempts = new Map<string, number>();
                let failedResult = result;
                while (!failedResult.ok) {
                    const failedCtx = await getFailedCtx({
                        runId: req.runId,
                        workspaceName: req.workspaceName,
                        stepIndex,
                        step,
                        rawResult: failedResult,
                        stopOnError,
                        checkpointEnabled,
                        checkpointAttempt: 0,
                        checkpointAttempts: Object.fromEntries(checkpointAttempts),
                        checkpointMaxAttempts,
                        inCheckpointFlow: false,
                        deps: resolvedDeps,
                        executeStep: (nestedStep, stepResolves) => executeOne(
                            nestedStep,
                            req.workspaceName,
                            runLocalStepResults,
                            resolvedDeps,
                            stepResolves ?? req.stepResolves,
                            checkpointRuntime!.provider,
                            checkpointRuntime!.entityRulesResolver,
                            checkpointRuntime!.resolveResolver,
                        ),
                        checkpoints: checkpointRuntime.checkpoints,
                        checkpointStepResolves: checkpointRuntime.stepResolves,
                        checkpointBodies: checkpointRuntime.bodies,
                        checkpointRuntime: {
                            ...checkpointRuntime,
                            checkpointStepResolves: checkpointRuntime.stepResolves,
                            checkpointBodies: checkpointRuntime.bodies,
                        },
                    });
                    const checkpointOutput = await runCheckpoint(failedCtx);
                    finalResult = checkpointOutput.finalResult;
                    nextStatus = checkpointOutput.nextStatus;
                    const checkpointId = typeof checkpointOutput.meta?.checkpointId === 'string'
                        ? checkpointOutput.meta.checkpointId
                        : undefined;
                    if (checkpointId) {
                        checkpointAttempts.set(checkpointId, (checkpointAttempts.get(checkpointId) ?? 0) + 1);
                    }
                    if (
                        nextStatus
                        || finalResult.ok
                        || checkpointOutput.meta?.stopReason !== 'checkpoint_retry_failed'
                        || !checkpointId
                    ) {
                        break;
                    }
                    failedResult = finalResult;
                }
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
            runLocalStepResults[finalResult.stepId] = {
                ok: finalResult.ok,
                data: finalResult.data,
                error: finalResult.error,
            };
            await writeRunnerStepResultCache(resolvedDeps, req.workspaceName, req.runId, finalResult);
            pushResultPipe(req.resultPipe, output);
            activeResultPublished = true;
            activeStep = undefined;

            if (nextStatus === 'suspended') {
                status = 'suspended';
            } else if (!finalResult.ok && stopOnError) {
                status = 'failed';
            }

            if (status === 'failed') {
                return await finish(status);
            }
            const checkpoint = checkpointOf(req.runId, req.workspaceName, status, req.stepsQueue.cursor);
            await req.onCheckpoint?.(checkpoint);
            continue;
        }

        if (req.stepsQueue.closed) {
            status = 'completed';
            return await finish(status);
        }

        await waitForInput(req.stepsQueue, req.signalChannel);
        }
    } catch (error) {
        return await fail(error);
    }
};

export const runStepList = async (
    workspaceName: string,
    steps: StepUnion[],
    deps?: RunStepsDeps,
    opts?: {
        stopOnError?: boolean;
        runId?: string;
        stepResolves?: Record<string, StepResolve>;
        checkpoints?: RunnerCheckpoint[];
        checkpointEnabled?: boolean;
        checkpointMaxAttempts?: number;
    },
): Promise<{ checkpoint: Checkpoint; pipe: ResultPipe }> => {
    const queue = createStepsQueue(steps, { closed: true });
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps(
        {
            runId: opts?.runId || crypto.randomUUID(),
            workspaceName,
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            stepResolves: opts?.stepResolves,
            checkpoints: opts?.checkpoints,
            checkpointEnabled: opts?.checkpointEnabled,
            checkpointMaxAttempts: opts?.checkpointMaxAttempts,
            stopOnError: opts?.stopOnError,
        },
        deps,
    );
    return { checkpoint, pipe };
};
