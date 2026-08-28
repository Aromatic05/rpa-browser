import { runDslSource } from '../../dsl/runtime';
import { DslRuntimeError } from '../../../program/dsl/diagnostics/errors';
import type { DslEntityRulesResolver, DslResolveResolver } from '../../dsl/link';
import type { StepResolve, StepResult, StepUnion } from '../steps/types';
import type { Checkpoint } from './types';
import type { DslCheckpointProvider } from '../../dsl/emit';
import type { RunStepsDeps } from '../run_steps_types';
import type {DslDebugPort, DslExecutionFrameSnapshot} from '../../dsl/debug/contracts';

export const MAX_CHECKPOINT_DSL_DEPTH = 16;

export const runCheckpointDslBody = async (options: {
    checkpoint: Checkpoint;
    source: string;
    input?: Record<string, unknown>;
    failure?: Record<string, unknown>;
    stepResolves: Record<string, StepResolve>;
    executeStep: (step: StepUnion) => Promise<StepResult>;
    workspaceName: string;
    deps: RunStepsDeps;
    entityRulesResolver?: DslEntityRulesResolver;
    resolveResolver?: DslResolveResolver;
    callStack?: string[];
    checkpointProvider?: DslCheckpointProvider;
    debugPort?: DslDebugPort;
    debugFrames?: readonly DslExecutionFrameSnapshot[];
}): Promise<Record<string, unknown>> => {
    const stack = options.callStack || [];
    if (stack.includes(options.checkpoint.id)) {
        throw new DslRuntimeError(`recursive checkpoint call: ${[...stack, options.checkpoint.id].join(' -> ')}`, 'ERR_DSL_CHECKPOINT_RECURSION');
    }
    if (stack.length >= MAX_CHECKPOINT_DSL_DEPTH) {
        throw new DslRuntimeError('checkpoint call depth exceeded', 'ERR_DSL_CHECKPOINT_DEPTH');
    }
    const resolveResolver: DslResolveResolver = {
        resolveBundle: (name) => name === options.checkpoint.id
            ? {resolves: options.stepResolves, diagnostics: []}
            : options.resolveResolver?.resolveBundle(name) || {resolves: null, diagnostics: []},
    };
    const result = await runDslSource(options.source, {
        workspaceName: options.workspaceName,
        deps: options.deps,
        input: {...(options.checkpoint.input || {}), ...(options.input || {})},
        failure: options.failure,
        stepExecutionPort: {execute: options.executeStep},
        entityRulesResolver: options.entityRulesResolver,
        resolveResolver,
        checkpointProvider: options.checkpointProvider,
        checkpointCallStack: [...stack, options.checkpoint.id],
        stepResolves: options.stepResolves,
        debugPort: options.debugPort,
        debugProgramId: `checkpoint:${options.checkpoint.id}`,
        debugFrames: options.debugFrames,
    });
    return result.scope.output;
};
