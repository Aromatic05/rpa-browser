import {
    executeStepWithRuntimeContracts,
    type RunStepsDeps,
} from '../../automation/runner/run_steps';
import {materializeReferencedCheckpointRuntimeSnapshot, isAutomaticRecoveryCheckpoint} from '../../automation/runner/checkpoint';
import {
    checkpointRuntimeSnapshotFromImage,
    type CheckpointRuntimeSnapshotImage,
} from '../../automation/runner/checkpoint/runtime_snapshot';
import type {Checkpoint} from '../../automation/runner/checkpoint/types';
import {
    compileDslSource,
    type StepExecutionPort,
} from '../../automation/dsl/runtime';
import {createCredentialResolvingStepExecutor} from '../../automation/dsl/runtime/credentials';
import {createDenyAllCredentialResolver, type CredentialResolver} from '../../security/credentials';
import {
    DslParseError,
    DslValidationError,
    UnsupportedError,
} from '../../program/dsl/diagnostics/errors';
import {createDslDebugExecutionSession} from '../debug/execution/dsl_session';
import type {
    DslDebugExecutionSession,
    DslDebugTerminalFailure,
} from '../debug/execution/contracts';
import {createWorkspaceWorldViewSource} from '../worldview/workspace';
import type {WorldViewSource} from '../worldview/contracts';
import {tryRetainedRecovery} from '../debug/recovery/retained_recovery';
import type {RetainedRecoverySummary} from '../debug/recovery/types';
import type {
    AgentProgram,
    AgentProgramExecutionStart,
    AgentProgramExecutor,
} from '../execution/program/contracts';
import type {AgentProgramEffectSummary, AgentProgramExecutionSummary} from '../execution/types';
import {exportProgramExecutionImage, rehydrateProgramExecutionImage} from '../continuation';
import {
    jsonRoundTripWorkspaceContinuationImage,
    parseWorkspaceContinuationImage,
    WORKSPACE_CONTINUATION_IMAGE_SCHEMA,
    WORKSPACE_CONTINUATION_IMAGE_VERSION,
} from '../continuation/workspace';

const runtimeImages = new WeakMap<DslDebugExecutionSession, CheckpointRuntimeSnapshotImage>();

export type CreateWorkspaceProgramExecutorOptions = {
    workspaceName: string;
    deps: RunStepsDeps;
    runWorkspaceExecution: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
    credentialResolver?: CredentialResolver;
    worldViewSource?: WorldViewSource;
};

export type WorkspaceProgramExecutor = AgentProgramExecutor & {
    exportContinuation: (start: AgentProgramExecutionStart) => unknown;
    restoreContinuation: (image: unknown) => Promise<
        | Readonly<{ok: true; start: AgentProgramExecutionStart}>
        | Readonly<{ok: false; error: Readonly<{code: string; message: string}>}>
    >;
};

const invalidProgram = (
    program: AgentProgram,
    error: DslParseError | DslValidationError | UnsupportedError,
): AgentProgramExecutionStart => ({
    summary: {
        source: program.source,
        input: structuredClone(program.input),
        status: 'invalid',
        error: {
            code: error.code,
            message: error.message,
            ...('diagnostics' in error ? {details: structuredClone(error.diagnostics)} : {}),
        },
        effects: [],
    },
});

const effectSummaries = (session: DslDebugExecutionSession): readonly AgentProgramEffectSummary[] =>
    session.auditEffects().map((record) => Object.freeze({
        sequence: record.sequence,
        stepName: record.effect.stepName,
        status: record.outcome.status,
        worldBefore: structuredClone(record.worldBefore.revision),
        worldAfter: structuredClone(record.worldAfter.revision),
        ...(record.compensates ? {compensates: record.compensates.effectSequence} : {}),
    }));

const normalizeFailure = (error: unknown): DslDebugTerminalFailure => {
    if (error && typeof error === 'object') {
        const value = error as {code?: unknown; message?: unknown; details?: unknown};
        return Object.freeze({
            code: typeof value.code === 'string' ? value.code : 'ERR_DSL_RUNTIME',
            message: typeof value.message === 'string' ? value.message : 'DSL execution failed',
            ...(value.details === undefined ? {} : {details: structuredClone(value.details)}),
        });
    }
    return Object.freeze({
        code: 'ERR_DSL_RUNTIME',
        message: typeof error === 'string' ? error : 'DSL execution failed',
    });
};

const listRecoveryCheckpoints = (
    provider: {listCheckpoints?: () => Checkpoint[]},
): Checkpoint[] => {
    try {
        return provider.listCheckpoints?.() ?? [];
    } catch {
        return [];
    }
};

const lockedDebugSession = (
    session: DslDebugExecutionSession,
    runWorkspaceExecution: CreateWorkspaceProgramExecutorOptions['runWorkspaceExecution'],
): DslDebugExecutionSession => {
    const locked: DslDebugExecutionSession = {
        ...session,
        commit: (continuationId) => runWorkspaceExecution(
            'agent.program.commit',
            () => session.commit(continuationId),
        ),
        rollback: (continuationId, savepointId, options) => runWorkspaceExecution(
            'agent.program.rollback',
            () => session.rollback(continuationId, savepointId, options),
        ),
        rewind: (continuationId, savepointId, options) => runWorkspaceExecution(
            'agent.program.rewind',
            () => session.rewind(continuationId, savepointId, options),
        ),
        refresh: (continuationId) => runWorkspaceExecution(
            'agent.program.refresh',
            () => session.refresh(continuationId),
        ),
        crossBarrier: (continuationId) => runWorkspaceExecution(
            'agent.program.cross_barrier',
            () => session.crossBarrier(continuationId),
        ),
        advance: (continuationId, mode) => runWorkspaceExecution(
            'agent.program.advance',
            () => session.advance(continuationId, mode),
        ),
    };
    const image = runtimeImages.get(session);
    if (image) {runtimeImages.set(locked, image);}
    return locked;
};

const summary = (
    program: AgentProgram,
    session: DslDebugExecutionSession,
    status: AgentProgramExecutionSummary['status'],
    options: Readonly<{text?: string; error?: AgentProgramExecutionSummary['error']; recovery?: RetainedRecoverySummary}> = {},
): AgentProgramExecutionSummary => ({
    source: program.source,
    input: structuredClone(program.input),
    status,
    ...(options.text ? {text: options.text} : {}),
    ...(options.error ? {error: options.error} : {}),
    ...(options.recovery ? {recovery: options.recovery} : {}),
    effects: effectSummaries(session),
});

export const createWorkspaceProgramExecutor = (
    options: CreateWorkspaceProgramExecutorOptions,
): WorkspaceProgramExecutor => {
    const executeProgram = async (program: AgentProgram): Promise<AgentProgramExecutionStart> => {
    const workspace = options.deps.resolveWorkspace(options.workspaceName);
    const checkpointProvider = workspace.checkpoint.getProvider(workspace.workflow);
    let runtime: ReturnType<typeof materializeReferencedCheckpointRuntimeSnapshot>;
    try {
        const allCheckpoints = listRecoveryCheckpoints(checkpointProvider);
        const recoveryCheckpoints = allCheckpoints.filter(isAutomaticRecoveryCheckpoint);
        const checkpointStepResolves = Object.fromEntries(recoveryCheckpoints.map((checkpoint) => [
            checkpoint.id,
            checkpointProvider.getCheckpointResolves?.(checkpoint.id) ?? {},
        ]));
        const checkpointBodies = Object.fromEntries(recoveryCheckpoints.flatMap((checkpoint) => {
            const body = checkpointProvider.getCheckpointBody?.(checkpoint.id);
            return body ? [[checkpoint.id, body.source] as const] : [];
        }));
        const recoverySources = Object.values(checkpointBodies);
        runtime = materializeReferencedCheckpointRuntimeSnapshot({
            sources: [program.source, ...recoverySources],
            checkpointProvider,
            checkpoints: allCheckpoints,
            checkpointStepResolves,
            checkpointBodies,
            workflow: workspace.workflow,
            entityRulesProvider: workspace.entityRules.getProvider(workspace.workflow),
        });
        compileDslSource(program.source, runtime.entityRulesResolver, runtime.resolveResolver);
    } catch (error) {
        if (error instanceof DslParseError || error instanceof DslValidationError || error instanceof UnsupportedError) {
            return invalidProgram(program, error);
        }
        throw error;
    }

    const worldViewSource = options.worldViewSource ?? createWorkspaceWorldViewSource({
        workspaceName: options.workspaceName,
        deps: options.deps,
    });
    const resolver = options.credentialResolver ?? createDenyAllCredentialResolver();
    const executeStep = (step: Parameters<typeof executeStepWithRuntimeContracts>[0]) =>
        executeStepWithRuntimeContracts(step, options.workspaceName, options.deps, {
            checkpointProvider: runtime.provider,
            entityRulesProvider: runtime.entityRulesProvider,
            entityRulesResolver: runtime.entityRulesResolver,
            resolveResolver: runtime.resolveResolver,
        });
    const executeWithCredentials = createCredentialResolvingStepExecutor({resolver, execute: executeStep});
    const stepExecutionPort: StepExecutionPort = {
        execute: async (step, precondition) => executeWithCredentials(step, precondition),
    };
    const compensationPort = {
        execute: executeStep,
    };

    return await options.runWorkspaceExecution('agent.program.start', async () => {
        const session = createDslDebugExecutionSession({
            source: program.source,
            context: {
                workspaceName: options.workspaceName,
                deps: options.deps,
                input: structuredClone(program.input),
                checkpointProvider: runtime.provider,
                entityRulesResolver: runtime.entityRulesResolver,
                resolveResolver: runtime.resolveResolver,
                stepExecutionPort,
            },
            worldViewSource,
            compensationPort,
            debug: {
                initialMode: 'continue',
                breakOnFailure: true,
                barrierOn: ['unknown', 'compensatable', 'irreversible'],
                barrierResumeMode: 'continue',
            },
        });
        if (runtime.image) {runtimeImages.set(session, runtime.image);}
        const initial = await Promise.race([
            session.waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            session.waitForCompletion().then(
                (completed) => ({
                    status: 'completed' as const,
                    output: structuredClone(completed.scope.output),
                }),
                (error) => ({status: 'failed' as const, failure: normalizeFailure(error)}),
            ),
        ]);
        if (initial.status === 'completed') {
            return {
                summary: summary(program, session, 'completed', {text: JSON.stringify(initial.output)}),
            };
        }
        if (initial.status === 'failed') {
            return {
                summary: summary(program, session, 'failed', {
                    text: initial.failure.message,
                    error: {
                        code: initial.failure.code,
                        message: initial.failure.message,
                        ...(initial.failure.details === undefined ? {} : {details: initial.failure.details}),
                    },
                }),
            };
        }
        const retainedRecovery = initial.pause.reason === 'failure'
            ? await tryRetainedRecovery({session, pause: initial.pause, runtime})
            : {status: 'none' as const};
        if (retainedRecovery.status === 'recovered_with_retry') {
            const advance = retainedRecovery.advance;
            if (advance.status === 'completed') {
                return {
                    summary: summary(program, session, 'completed', {
                        text: JSON.stringify(advance.output),
                        recovery: retainedRecovery.summary,
                    }),
                };
            }
            if (advance.status === 'failed') {
                return {
                    summary: summary(program, session, 'failed', {
                        text: advance.failure.message,
                        error: {code: advance.failure.code, message: advance.failure.message},
                        recovery: retainedRecovery.summary,
                    }),
                };
            }
            if (advance.status === 'aborted') {
                return {
                    summary: summary(program, session, 'aborted', {
                        text: 'program execution was aborted',
                        recovery: retainedRecovery.summary,
                    }),
                };
            }
            if (advance.status === 'conflict') {
                return {
                    summary: summary(program, session, 'paused', {recovery: retainedRecovery.summary}),
                    debug: {session: lockedDebugSession(session, options.runWorkspaceExecution), pause: retainedRecovery.pause},
                };
            }
            return {
                summary: summary(program, session, 'paused', {recovery: retainedRecovery.summary}),
                debug: {session: lockedDebugSession(session, options.runWorkspaceExecution), pause: advance.pause},
            };
        }
        if (retainedRecovery.status === 'recovered'
            || retainedRecovery.status === 'recovery_failed'
            || retainedRecovery.status === 'needs_approval') {
            return {
                summary: summary(program, session, 'paused', {recovery: retainedRecovery.summary}),
                debug: {session: lockedDebugSession(session, options.runWorkspaceExecution), pause: retainedRecovery.pause},
            };
        }
        return {
            summary: summary(program, session, 'paused'),
            debug: {
                session: lockedDebugSession(session, options.runWorkspaceExecution),
                pause: initial.pause,
            },
        };
    });
    };
    const exportContinuation = (start: AgentProgramExecutionStart): unknown => {
        if (!start.debug) {throw new Error('program is not paused and cannot be continued');}
        const runtimeImage = runtimeImages.get(start.debug.session);
        if (!runtimeImage) {throw new Error('workspace runtime image is unavailable');}
        const execution = exportProgramExecutionImage(start.debug.session);
        if (!execution.ok) {throw new Error(execution.error.message);}
        const roundTrip = jsonRoundTripWorkspaceContinuationImage({
            schema: WORKSPACE_CONTINUATION_IMAGE_SCHEMA,
            version: WORKSPACE_CONTINUATION_IMAGE_VERSION,
            workspaceName: options.workspaceName,
            program: {
                source: start.summary.source,
                input: structuredClone(start.summary.input),
            },
            execution: execution.image,
            runtime: runtimeImage,
        });
        if (!roundTrip.ok) {throw new Error(roundTrip.error.message);}
        return roundTrip.image;
    };
    const restoreContinuation = async (value: unknown) => {
        const parsed = parseWorkspaceContinuationImage(value);
        if (!parsed.ok) {return parsed;}
        if (parsed.image.workspaceName !== options.workspaceName) {
            return {ok: false as const, error: {code: 'ERR_CONTINUATION_WORLD_CONFLICT', message: 'continuation belongs to a different workspace'}};
        }
        const runtime = checkpointRuntimeSnapshotFromImage(parsed.image.runtime);
        const worldViewSource = options.worldViewSource ?? createWorkspaceWorldViewSource({workspaceName: options.workspaceName, deps: options.deps});
        const resolver = options.credentialResolver ?? createDenyAllCredentialResolver();
        const executeStep = (step: Parameters<typeof executeStepWithRuntimeContracts>[0]) =>
            executeStepWithRuntimeContracts(step, options.workspaceName, options.deps, {
                checkpointProvider: runtime.provider,
                entityRulesProvider: runtime.entityRulesProvider,
                entityRulesResolver: runtime.entityRulesResolver,
                resolveResolver: runtime.resolveResolver,
            });
        const executeWithCredentials = createCredentialResolvingStepExecutor({
            resolver,
            execute: executeStep,
        });
        const stepExecutionPort: StepExecutionPort = {
            execute: async (step, precondition) => executeWithCredentials(step, precondition),
        };
        const program: AgentProgram = {
            source: parsed.image.program.source,
            input: structuredClone(parsed.image.program.input),
        };
        const rehydrated = await rehydrateProgramExecutionImage(parsed.image.execution, {
            worldViewSource,
            context: {
                workspaceName: options.workspaceName,
                deps: options.deps,
                input: structuredClone(program.input),
                checkpointProvider: runtime.provider,
                entityRulesResolver: runtime.entityRulesResolver,
                resolveResolver: runtime.resolveResolver,
                stepExecutionPort,
            },
            compensationPort: {execute: executeStep},
        });
        if (!rehydrated.ok) {return rehydrated;}
        if (runtime.image) {runtimeImages.set(rehydrated.session, runtime.image);}
        return {
            ok: true as const,
            start: {
                summary: summary(program, rehydrated.session, 'paused'),
                debug: {
                    session: lockedDebugSession(rehydrated.session, options.runWorkspaceExecution),
                    pause: rehydrated.pause,
                },
            },
        };
    };
    return Object.assign(executeProgram, {exportContinuation, restoreContinuation});
};

export const createWorkspaceContinuationRestorer = (
    options: CreateWorkspaceProgramExecutorOptions,
): WorkspaceProgramExecutor['restoreContinuation'] => {
    const executor = createWorkspaceProgramExecutor(options);
    return (image: unknown) => executor.restoreContinuation(image);
};
