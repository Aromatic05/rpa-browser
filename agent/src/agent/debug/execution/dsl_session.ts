import {
    createDslDebugController,
    type CreateDslDebugControllerOptions,
} from '../../../dsl/debug/controller';
import type {DslDebugPort, PausedDslExecution} from '../../../dsl/debug/contracts';
import {DslDebugAbortError} from '../../../dsl/debug/errors';
import {
    runDslSource,
    type RunDslContext,
    type RunDslSourceResult,
} from '../../../dsl/runtime';
import type {ComputeEvalScope} from '../../../runner/compute/evaluate';
import type {ComputeExpr, StepArgsMap} from '../../../runner/steps/types';
import type {WorldViewSource} from '../../worldview/contracts';
import {describeWorldView} from '../../worldview/descriptor';
import {isSameWorldView} from '../../worldview/revision';
import {createDebugEffectJournal} from '../effects/journal';
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
    const journal = createDebugEffectJournal();
    const debugPort: DslDebugPort = {
        beforeStatement: controller.port.beforeStatement,
        beforeEffect: async (event) => {
            await controller.port.beforeEffect?.(event);
            journal.begin(event, describeWorldView(await options.worldViewSource.pin()));
        },
        afterEffect: async (event) => {
            journal.finish(event, describeWorldView(await options.worldViewSource.pin()));
            await controller.port.afterEffect?.(event);
        },
        onFailure: controller.port.onFailure,
    };
    const completion: Promise<RunDslSourceResult> = runDslSource(options.source, {
        ...options.context,
        debugPort,
    });
    let active: ActivePause | null = null;

    const requireActive = (continuationId: string): ActivePause => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL debug continuation is not active: ${continuationId}`);
        }
        return active;
    };

    const exposePause = (value: ActivePause): PausedDslDebugExecution => {
        const {pause, debug} = value;
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

    const release = (continuationId: string, mode: 'continue' | 'step' | 'abort'): void => {
        requireActive(continuationId);
        active = null;
        if (mode === 'abort') {controller.abort(continuationId); return;}
        if (mode === 'step') {controller.step(continuationId); return;}
        controller.continue(continuationId);
    };

    const waitForPause = async (): Promise<PausedDslDebugExecution> => {
        if (active) {throw new Error('DSL debug execution is already paused');}
        const pause = await controller.waitForPause();
        const debug = createDebugQuerySession(await options.worldViewSource.pin());
        active = {pause, debug};
        return exposePause(active);
    };

    const refresh = async (continuationId: string): Promise<PausedDslDebugExecution> => {
        const current = requireActive(continuationId);
        active = {
            pause: current.pause,
            debug: createDebugQuerySession(await options.worldViewSource.pin()),
        };
        return exposePause(active);
    };

    const advance = async (
        continuationId: string,
        mode: 'continue' | 'step' | 'abort',
    ): Promise<DslDebugAdvanceResult> => {
        const current = requireActive(continuationId);
        const pausedFailure = current.pause.reason === 'failure' ? current.pause.failure : undefined;
        const abortedAt = Object.freeze({
            reason: current.pause.reason,
            location: current.pause.location,
        });
        if (mode !== 'abort' && current.pause.reason !== 'failure') {
            const actual = describeWorldView(await options.worldViewSource.pin());
            if (!isSameWorldView(current.debug.world, actual)) {
                return Object.freeze({
                    status: 'conflict' as const,
                    conflict: Object.freeze({expected: current.debug.world, actual}),
                });
            }
        }
        release(continuationId, mode);
        return await Promise.race([
            waitForPause().then((pause) => ({status: 'paused' as const, pause})),
            completion.then((result) => ({
                status: 'completed' as const,
                output: structuredClone(result.scope.output),
            }), (error) => error instanceof DslDebugAbortError
                ? {status: 'aborted' as const, at: abortedAt}
                : {
                    status: 'failed' as const,
                    failure: pausedFailure ?? normalizeTerminalFailure(error),
                }),
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
        effects: (continuationId: string) => {
            requireActive(continuationId);
            return journal.list();
        },
        refresh,
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
