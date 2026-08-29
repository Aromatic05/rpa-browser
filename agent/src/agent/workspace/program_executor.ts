import {
    executeStepWithRuntimeContracts,
    type RunStepsDeps,
} from '../../automation/runner/run_steps';
import {materializeReferencedCheckpointRuntimeSnapshot} from '../../automation/runner/checkpoint';
import {
    compileDslSource,
    type ExpectedWorldPrecondition,
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
import type {
    AgentProgram,
    AgentProgramExecutionStart,
    AgentProgramExecutor,
} from '../execution/program/contracts';
import type {AgentProgramEffectSummary, AgentProgramExecutionSummary} from '../execution/types';

export type CreateWorkspaceProgramExecutorOptions = {
    workspaceName: string;
    deps: RunStepsDeps;
    runWorkspaceExecution: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
    credentialResolver?: CredentialResolver;
    worldViewSource?: WorldViewSource;
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

const lockedDebugSession = (
    session: DslDebugExecutionSession,
    runWorkspaceExecution: CreateWorkspaceProgramExecutorOptions['runWorkspaceExecution'],
): DslDebugExecutionSession => ({
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
});

const summary = (
    program: AgentProgram,
    session: DslDebugExecutionSession,
    status: AgentProgramExecutionSummary['status'],
    options: Readonly<{text?: string; error?: AgentProgramExecutionSummary['error']}> = {},
): AgentProgramExecutionSummary => ({
    source: program.source,
    input: structuredClone(program.input),
    status,
    ...(options.text ? {text: options.text} : {}),
    ...(options.error ? {error: options.error} : {}),
    effects: effectSummaries(session),
});

export const createWorkspaceProgramExecutor = (
    options: CreateWorkspaceProgramExecutorOptions,
): AgentProgramExecutor => async (program: AgentProgram) => {
    const workspace = options.deps.resolveWorkspace(options.workspaceName);
    const checkpointProvider = workspace.checkpoint.getProvider(workspace.workflow);
    let runtime: ReturnType<typeof materializeReferencedCheckpointRuntimeSnapshot>;
    try {
        runtime = materializeReferencedCheckpointRuntimeSnapshot({
            sources: [program.source],
            checkpointProvider,
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
            entityRulesResolver: runtime.entityRulesResolver,
            resolveResolver: runtime.resolveResolver,
        });
    const executeWithCredentials = createCredentialResolvingStepExecutor({resolver, execute: executeStep});
    const worldConflict = (
        step: Parameters<typeof executeStepWithRuntimeContracts>[0],
        precondition: ExpectedWorldPrecondition,
        actual: {pageEpoch: string; captureRevision: number},
    ) => ({
        stepId: step.id,
        ok: false as const,
        error: {
            code: 'ERR_AGENT_WORLD_CONFLICT' as const,
            message: 'workspace world moved past the expected observation revision; refusing to mutate',
            details: {
                expected: {...precondition.revision},
                actual: {...actual},
            },
        },
    });
    const stepExecutionPort: StepExecutionPort = {
        execute: async (step, precondition) => {
            if (precondition) {
                const pinned = await worldViewSource.pin();
                const actual = pinned.revision;
                if (actual.pageEpoch !== precondition.revision.pageEpoch
                    || actual.captureRevision !== precondition.revision.captureRevision) {
                    return worldConflict(step, precondition, actual);
                }
            }
            return await executeWithCredentials(step, precondition);
        },
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
        return {
            summary: summary(program, session, 'paused'),
            debug: {
                session: lockedDebugSession(session, options.runWorkspaceExecution),
                pause: initial.pause,
            },
        };
    });
};
