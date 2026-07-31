import crypto from 'node:crypto';
import { runCheckpointProcedure } from '../../runner/checkpoint';
import { runCheckpointDslBody } from '../../runner/checkpoint/dsl_body';
import type { RunStepsDeps } from '../../runner/run_steps_types';
import type { DslEntityRulesResolver, DslResolveResolver } from '../link';
import type { Checkpoint } from '../../runner/checkpoint';
import type { StepResult, StepUnion } from '../../runner/steps/types';
import type { StepResolve } from '../../runner/steps/types';
import type { CheckpointStmt } from '../ast/types';
import { DslRuntimeError } from '../diagnostics/errors';
import { injectStepResolve } from '../../runner/step_resolve';
import type { DslScope } from '../runtime/scope';
import { resolveDslValue } from '../runtime/refs';

export type DslCheckpointProvider = {
    getCheckpoint(id: string): Checkpoint | null;
    getCheckpointResolves?: (id: string) => Record<string, StepResolve> | null;
    listCheckpoints?: () => Checkpoint[];
    getCheckpointBody?: (id: string) => {source: string; stepResolves: Record<string, StepResolve>} | null;
};

export type RunDslCheckpointOptions = {
    stmt: CheckpointStmt;
    scope: DslScope;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    checkpointProvider?: DslCheckpointProvider;
    workspaceName: string;
    deps: RunStepsDeps;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    callStack?: string[];
};

export const runDslCheckpointCall = async (
    options: RunDslCheckpointOptions,
): Promise<Record<string, unknown>> => {
    const checkpoint =
        options.checkpointProvider?.getCheckpoint(options.stmt.id) || null;
    if (!checkpoint) {
        throw new DslRuntimeError(`checkpoint not found: ${options.stmt.id}`, 'ERR_DSL_CHECKPOINT_NOT_FOUND');
    }

    const input = options.stmt.input
        ? Object.fromEntries(
              Object.entries(options.stmt.input).map(([key, value]) => [key, resolveDslValue(value, options.scope)]),
          )
        : undefined;

    const stepResolves = options.checkpointProvider?.getCheckpointResolves?.(options.stmt.id) || {};
    const body = options.checkpointProvider?.getCheckpointBody?.(options.stmt.id);
    if (checkpoint.body) {
        if (!body) {throw new DslRuntimeError(`checkpoint body unavailable: ${options.stmt.id}`, 'ERR_DSL_CHECKPOINT_BODY_MISSING');}
        if (checkpoint.kind && checkpoint.kind !== 'procedure') {
            throw new DslRuntimeError(`checkpoint is not callable: ${options.stmt.id}`, 'ERR_DSL_CHECKPOINT_NOT_CALLABLE');
        }
        return await runCheckpointDslBody({
            checkpoint, source: body.source, input, stepResolves: body.stepResolves,
            executeStep: options.executeStep, workspaceName: options.workspaceName, deps: options.deps,
            entityRulesResolver: options.entityRulesResolver, resolveResolver: options.resolveResolver, callStack: options.callStack,
            checkpointProvider: options.checkpointProvider,
        });
    }
    if (checkpoint.kind && checkpoint.kind !== 'procedure') {
        throw new DslRuntimeError(`checkpoint is not callable: ${options.stmt.id}`, 'ERR_DSL_CHECKPOINT_NOT_CALLABLE');
    }
    const result = await runCheckpointProcedure({
        checkpoint,
        input,
        stepIdPrefix: `dsl:checkpoint:${options.stmt.id}:${crypto.randomUUID()}`,
        executeStep: async (step) => {
            const runtimeStep = injectStepResolve(step, stepResolves);
            if (!runtimeStep.ok) {return {stepId: step.id, ok: false, error: runtimeStep.error};}
            return await options.executeStep(runtimeStep.step);
        },
    });
    if (!result.ok) {
        throw new DslRuntimeError(result.error?.message || `checkpoint failed: ${options.stmt.id}`, result.error?.code);
    }

    return result.output || {};
};
