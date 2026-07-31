import { runDslSource, type StepExecutionPort } from '../../dsl/runtime';
import { DslRuntimeError } from '../../dsl/diagnostics/errors';
import type { DslEntityRulesResolver, DslResolveResolver } from '../../dsl/link';
import type { StepResolve, StepResult, StepUnion } from '../steps/types';
import type { Checkpoint } from './types';
import type { DslCheckpointProvider } from '../../dsl/emit';

export const MAX_CHECKPOINT_DSL_DEPTH = 16;

export const runCheckpointDslBody = async (options: {
    checkpoint: Checkpoint;
    source: string;
    input?: Record<string, unknown>;
    stepResolves: Record<string, StepResolve>;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    workspaceName: string;
    deps: import('../run_steps_types').RunStepsDeps;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    callStack?: string[];
    checkpointProvider?: DslCheckpointProvider;
}): Promise<Record<string, unknown>> => {
    const stack = options.callStack || [];
    if (stack.includes(options.checkpoint.id)) {
        throw new DslRuntimeError(`recursive checkpoint call: ${[...stack, options.checkpoint.id].join(' -> ')}`, 'ERR_DSL_CHECKPOINT_RECURSION');
    }
    if (stack.length >= MAX_CHECKPOINT_DSL_DEPTH) {
        throw new DslRuntimeError('checkpoint call depth exceeded', 'ERR_DSL_CHECKPOINT_DEPTH');
    }
    const port: StepExecutionPort = {
        execute: async (step) => {
            const resolveId = typeof (step.args as Record<string, unknown>).resolveId === 'string'
                ? (step.args as Record<string, unknown>).resolveId as string : undefined;
            const runtimeStep = resolveId && options.stepResolves[resolveId]
                ? {...step, args: Object.fromEntries(Object.entries(step.args).filter(([key]) => key !== 'resolveId')), resolve: options.stepResolves[resolveId]} as StepUnion
                : step;
            return await options.executeStep(runtimeStep);
        },
    };
    const resolveResolver: DslResolveResolver = {
        resolveBundle: (name) => name === options.checkpoint.id
            ? {resolves: options.stepResolves, diagnostics: []}
            : options.resolveResolver?.resolveBundle(name) || {resolves: null, diagnostics: []},
    };
    const result = await runDslSource(options.source, {
        workspaceName: options.workspaceName,
        deps: options.deps,
        input: {...(options.checkpoint.input || {}), ...(options.input || {})},
        stepExecutionPort: port,
        entityRulesResolver: options.entityRulesResolver,
        resolveResolver,
        checkpointProvider: options.checkpointProvider,
        checkpointCallStack: [...stack, options.checkpoint.id],
    });
    return result.scope.output;
};
