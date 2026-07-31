import type { Step, StepResult } from '../types';
import {
    executeStepWithRuntimeContracts,
    type RunLocalStepResults,
    type RunStepsDeps,
    type RunStepsExecutionContext,
} from '../../run_steps';
import { runCheckpointProcedure } from '../../checkpoint/runtime';
import { runCheckpointDslBody } from '../../checkpoint/dsl_body';
import type {StepResolve, StepUnion} from '../types';

export const executeBrowserCheckpoint = async (
    step: Step<'browser.checkpoint'>,
    deps: RunStepsDeps,
    workspaceName: string,
    context?: RunStepsExecutionContext,
): Promise<StepResult> => {
    const provider = context?.checkpointProvider;
    if (!provider) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_PROVIDER_UNAVAILABLE',
                message: `checkpoint provider unavailable for step: ${step.id}`,
            },
        };
    }
    const checkpoint = provider.getCheckpoint(step.args.checkpointId);
    if (!checkpoint) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: `checkpoint not found: ${step.args.checkpointId}`,
            },
        };
    }
    if (checkpoint.kind && checkpoint.kind !== 'procedure') {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_NOT_CALLABLE',
                message: `checkpoint is not callable: ${step.args.checkpointId}`,
            },
        };
    }
    const body = checkpoint.body ? provider.getCheckpointBody?.(step.args.checkpointId) : null;
    if (checkpoint.body && !body) {
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_CHECKPOINT_BODY_MISSING',
                message: `checkpoint body unavailable: ${step.args.checkpointId}`,
            },
        };
    }
    const stepResolves: Record<string, StepResolve> = body?.stepResolves
        ?? provider.getCheckpointResolves?.(step.args.checkpointId)
        ?? {};
    const nestedResults: RunLocalStepResults = {};

    const executeNestedStep = async (nestedStep: StepUnion): Promise<StepResult> => {
        const result = await executeStepWithRuntimeContracts(nestedStep, workspaceName, deps, {
            runLocalStepResults: nestedResults,
            stepResolves,
            checkpointProvider: provider,
            entityRulesResolver: context?.entityRulesResolver,
            resolveResolver: context?.resolveResolver,
        });
        nestedResults[result.stepId] = {
            ok: result.ok,
            data: result.data,
            error: result.error,
        };
        return result;
    };

    if (body) {
        try {
            const output = await runCheckpointDslBody({
                checkpoint,
                source: body.source,
                input: step.args.input,
                stepResolves,
                executeStep: executeNestedStep,
                workspaceName,
                deps,
                entityRulesResolver: context?.entityRulesResolver,
                resolveResolver: context?.resolveResolver,
                checkpointProvider: provider,
            });
            return {
                stepId: step.id,
                ok: true,
                data: {checkpointId: checkpoint.id, output},
            };
        } catch (error) {
            return {
                stepId: step.id,
                ok: false,
                error: {
                    code: error instanceof Error && 'code' in error ? String((error as {code: unknown}).code) : 'ERR_CHECKPOINT_BODY_FAILED',
                    message: error instanceof Error ? error.message : String(error),
                    ...(error && typeof error === 'object' && 'details' in error
                        ? {details: (error as {details?: unknown}).details}
                        : {}),
                },
            };
        }
    }

    const output = await runCheckpointProcedure({
        checkpoint,
        input: step.args.input,
        stepIdPrefix: `checkpoint:${step.id}`,
        executeStep: executeNestedStep,
    });

    if (!output.ok) {
        return {
            stepId: step.id,
            ok: false,
            error: output.error,
        };
    }

    return {
        stepId: step.id,
        ok: true,
        data: {
            checkpointId: checkpoint.id,
            output: output.output || {},
        },
    };
};
