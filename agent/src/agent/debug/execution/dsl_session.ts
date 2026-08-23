import {
    createDslDebugController,
    type CreateDslDebugControllerOptions,
} from '../../../dsl/debug/controller';
import type {PausedDslExecution} from '../../../dsl/debug/contracts';
import {
    runDslSource,
    type RunDslContext,
    type RunDslSourceResult,
} from '../../../dsl/runtime';
import type {ComputeEvalScope} from '../../../runner/compute/evaluate';
import type {ComputeExpr, StepArgsMap} from '../../../runner/steps/types';
import type {WorldViewSource} from '../../worldview/contracts';
import {createDebugQuerySession} from '../query/session';
import type {DebugQuerySession} from '../query/contracts';
import type {
    DslDebugAdvanceResult,
    DslDebugExecutionSession,
    PausedDslDebugExecution,
} from './contracts';

export type CreateDslDebugExecutionSessionOptions = {
    source: string;
    context: Omit<RunDslContext, 'debugPort'>;
    worldViewSource: WorldViewSource;
    debug?: CreateDslDebugControllerOptions;
};

type ActivePause = {
    pause: PausedDslExecution;
    debug: DebugQuerySession;
};

export const createDslDebugExecutionSession = (
    options: CreateDslDebugExecutionSessionOptions,
): DslDebugExecutionSession => {
    const controller = createDslDebugController(options.debug);
    const completion: Promise<RunDslSourceResult> = runDslSource(options.source, {
        ...options.context,
        debugPort: controller.port,
    });
    let active: ActivePause | null = null;

    const requireActive = (continuationId: string): ActivePause => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL debug continuation is not active: ${continuationId}`);
        }
        return active;
    };

    const release = (continuationId: string, mode: 'continue' | 'step'): void => {
        requireActive(continuationId);
        active = null;
        if (mode === 'step') {controller.step(continuationId); return;}
        controller.continue(continuationId);
    };

    const waitForPause = async (): Promise<PausedDslDebugExecution> => {
        if (active) {throw new Error('DSL debug execution is already paused');}
        const pause = await controller.waitForPause();
        const debug = createDebugQuerySession(await options.worldViewSource.pin());
        active = {pause, debug};
        const base = {
            continuationId: pause.continuationId,
            reason: pause.reason,
            location: pause.location,
            scope: pause.scope,
            world: debug.world,
        } as const;
        return pause.reason === 'effect'
            ? Object.freeze({...base, reason: 'effect' as const, effect: pause.effect})
            : pause.reason === 'failure'
                ? Object.freeze({...base, reason: 'failure' as const, failure: pause.failure})
            : Object.freeze({...base, reason: 'statement' as const});
    };

    const advance = async (
        continuationId: string,
        mode: 'continue' | 'step',
    ): Promise<DslDebugAdvanceResult> => {
        const current = requireActive(continuationId);
        const pausedFailure = current.pause.reason === 'failure' ? current.pause.failure : undefined;
        release(continuationId, mode);
        return await Promise.race([
            waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            completion.then((result) => ({
                status: 'completed' as const,
                output: structuredClone(result.scope.output),
            }), (error) => ({
                status: 'failed' as const,
                failure: pausedFailure ?? normalizeTerminalFailure(error),
            })),
        ]);
    };

    return {
        waitForPause,
        query: (continuationId: string, args: StepArgsMap['browser.query']) =>
            requireActive(continuationId).debug.query(args),
        compute: (
            continuationId: string,
            expr: ComputeExpr,
            scope: ComputeEvalScope = {},
        ) => requireActive(continuationId).debug.compute(expr, scope),
        continue: (continuationId: string) => {release(continuationId, 'continue');},
        step: (continuationId: string) => {release(continuationId, 'step');},
        advance,
        waitForCompletion: async () => await completion,
    };
};

const normalizeTerminalFailure = (error: unknown) => {
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
