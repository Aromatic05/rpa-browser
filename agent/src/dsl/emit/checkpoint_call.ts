import crypto from 'node:crypto';
import { listCheckpoints, runCheckpointProcedure } from '../../runner/checkpoint';
import type { Checkpoint } from '../../runner/checkpoint';
import type { StepResult, StepUnion } from '../../runner/steps/types';
import type { StepResolve } from '../../runner/steps/types';
import type { CheckpointStmt } from '../ast/types';
import { DslRuntimeError } from '../diagnostics/errors';
import type { DslScope } from '../runtime/scope';
import { resolveDslValue } from '../runtime/refs';

export type DslCheckpointProvider = {
    getCheckpoint(id: string): Checkpoint | null;
    getCheckpointResolves?: (id: string) => Record<string, StepResolve> | null;
};

export type RunDslCheckpointOptions = {
    stmt: CheckpointStmt;
    scope: DslScope;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    checkpointProvider?: DslCheckpointProvider;
};

export const runDslCheckpointCall = async (
    options: RunDslCheckpointOptions,
): Promise<Record<string, unknown>> => {
    const checkpoint =
        options.checkpointProvider?.getCheckpoint(options.stmt.id) ||
        listCheckpoints().find((item) => item.id === options.stmt.id) ||
        null;
    if (!checkpoint) {
        throw new DslRuntimeError(`checkpoint not found: ${options.stmt.id}`, 'ERR_DSL_CHECKPOINT_NOT_FOUND');
    }

    const input = options.stmt.input
        ? Object.fromEntries(
              Object.entries(options.stmt.input).map(([key, value]) => [key, resolveDslValue(value, options.scope)]),
          )
        : undefined;

    const stepResolves = options.checkpointProvider?.getCheckpointResolves?.(options.stmt.id) || {};
    const result = await runCheckpointProcedure({
        checkpoint,
        input,
        stepIdPrefix: `dsl:checkpoint:${options.stmt.id}:${crypto.randomUUID()}`,
        executeStep: async (step) => {
            const args = step.args as Record<string, unknown>;
            const resolveId = typeof args.resolveId === 'string' ? args.resolveId : '';
            if (!resolveId || !stepResolves[resolveId]) {
                return await options.executeStep(step);
            }
            const runtimeStep: StepUnion = {
                ...step,
                resolve: stepResolves[resolveId],
            };
            return await options.executeStep(runtimeStep);
        },
    });
    if (!result.ok) {
        throw new DslRuntimeError(result.error?.message || `checkpoint failed: ${options.stmt.id}`, result.error?.code);
    }

    return result.output || {};
};
