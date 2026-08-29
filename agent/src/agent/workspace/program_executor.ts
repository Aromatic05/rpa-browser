import {
    executeStepWithRuntimeContracts,
    type RunStepsDeps,
} from '../../automation/runner/run_steps';
import {materializeReferencedCheckpointRuntimeSnapshot} from '../../automation/runner/checkpoint';
import {compileDslSource} from '../../automation/dsl/runtime';
import {
    DslParseError,
    DslValidationError,
    UnsupportedError,
} from '../../program/dsl/diagnostics/errors';
import {createPausedDslDebugAgentRunner} from '../debug/execution/agent_runner';
import type {AgentModelRuntime} from '../model/runtime';
import {createWorkspaceWorldViewSource} from '../worldview/workspace';
import type {AgentProgram, AgentProgramExecutor} from '../execution/program/contracts';
import type {AgentProgramExecutionSummary, AgentRunRequest} from '../execution/types';

export type CreateWorkspaceProgramExecutorOptions = {
    workspaceName: string;
    deps: RunStepsDeps;
    modelRuntime?: AgentModelRuntime;
    runWorkspaceExecution: <T>(actionType: string, run: () => Promise<T>) => Promise<T>;
};

const invalidProgram = (
    program: AgentProgram,
    error: DslParseError | DslValidationError | UnsupportedError,
): AgentProgramExecutionSummary => ({
    source: program.source,
    input: structuredClone(program.input),
    status: 'invalid',
    error: {
        code: error.code,
        message: error.message,
        ...('diagnostics' in error ? {details: structuredClone(error.diagnostics)} : {}),
    },
    effects: [],
});

export const createWorkspaceProgramExecutor = (
    options: CreateWorkspaceProgramExecutorOptions,
): AgentProgramExecutor => async (program: AgentProgram, request: AgentRunRequest) => {
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
    const worldViewSource = createWorkspaceWorldViewSource({
        workspaceName: options.workspaceName,
        deps: options.deps,
    });
    const compensationPort = {
        execute: (step: Parameters<typeof executeStepWithRuntimeContracts>[0]) =>
            executeStepWithRuntimeContracts(step, options.workspaceName, options.deps, {
                checkpointProvider: runtime.provider,
                entityRulesResolver: runtime.entityRulesResolver,
                resolveResolver: runtime.resolveResolver,
            }),
    };

    try {
        const result = await options.runWorkspaceExecution('agent.program.execute', () =>
            createPausedDslDebugAgentRunner({
                source: program.source,
                context: {
                    workspaceName: options.workspaceName,
                    deps: options.deps,
                    input: structuredClone(program.input),
                    checkpointProvider: runtime.provider,
                    entityRulesResolver: runtime.entityRulesResolver,
                    resolveResolver: runtime.resolveResolver,
                },
                worldViewSource,
                compensationPort,
                modelRuntime: options.modelRuntime,
                debug: {
                    initialMode: 'continue',
                    breakOnFailure: true,
                    barrierOn: ['unknown', 'compensatable', 'irreversible'],
                    barrierResumeMode: 'continue',
                },
            }).run({...request, systemPrompt: undefined}),
        );
        const execution = result.execution;
        const effects = result.session.auditEffects().map((record) => Object.freeze({
            sequence: record.sequence,
            stepName: record.effect.stepName,
            status: record.outcome.status,
            ...(record.compensates ? {compensates: record.compensates.effectSequence} : {}),
        }));
        const error = execution.status === 'failed'
            ? {
                code: execution.failure.code,
                message: execution.failure.message,
                ...(execution.failure.details === undefined ? {} : {details: execution.failure.details}),
            }
            : execution.status === 'aborted'
                ? {code: 'ERR_AGENT_PROGRAM_ABORTED', message: 'program execution was aborted'}
                : execution.status === 'paused'
                    ? {code: 'ERR_AGENT_PROGRAM_PAUSED', message: 'program execution remained paused'}
                    : undefined;
        return {
            source: program.source,
            input: structuredClone(program.input),
            status: execution.status,
            text: result.text,
            ...(error ? {error} : {}),
            trace: result.trace,
            effects,
        };
    } catch (error) {
        if (error instanceof DslParseError || error instanceof DslValidationError || error instanceof UnsupportedError) {
            return invalidProgram(program, error);
        }
        throw error;
    }
};
