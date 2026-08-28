import crypto from 'node:crypto';
import {DslDebugAbortError} from './errors';
import type {
    DslBeforeEffectEvent,
    DslBeforeStatementEvent,
    DslDebugController,
    DslFailureEvent,
    PausedDslExecution,
} from './contracts';
import type {DslStmt} from '../../../program/dsl/ast/types';
import type {EffectReversibility} from '../../../program/effects/contracts';

export type CreateDslDebugControllerOptions = {
    initialMode?: 'continue' | 'step';
    breakpoints?: readonly string[];
    breakBeforeEffects?: boolean;
    breakOnFailure?: boolean;
    barrierOn?: readonly EffectReversibility[];
};

type ActivePause = {
    pause: PausedDslExecution;
    resume: (action: 'resume' | 'abort') => void;
    statementOverride?: DslStmt;
};

export const createDslDebugController = (
    options: CreateDslDebugControllerOptions = {},
): DslDebugController => {
    const breakpoints = new Set(options.breakpoints ?? []);
    const barrierOn = new Set(options.barrierOn ?? []);
    const queued: PausedDslExecution[] = [];
    const waiters: Array<(pause: PausedDslExecution) => void> = [];
    let mode = options.initialMode ?? 'continue';
    let active: ActivePause | null = null;

    const publish = (pause: PausedDslExecution): void => {
        const waiter = waiters.shift();
        if (waiter) {waiter(pause); return;}
        queued.push(pause);
    };

    const release = (
        continuationId: string,
        nextMode: 'continue' | 'step',
        allowBarrier = false,
    ): void => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL continuation is not paused: ${continuationId}`);
        }
        if (active.pause.reason === 'barrier' && !allowBarrier) {
            throw new Error(`DSL continuation is paused at a commit barrier: ${continuationId}`);
        }
        mode = nextMode;
        active.resume('resume');
    };

    const pause = async (value: PausedDslExecution): Promise<ActivePause> => {
        if (active) {throw new Error('DSL debugger already has an active continuation');}
        let paused!: ActivePause;
        const action = await new Promise<'resume' | 'abort'>((resolve) => {
            paused = {pause: value, resume: resolve};
            active = paused;
            publish(value);
        });
        active = null;
        if (action === 'abort') {throw new DslDebugAbortError(value.continuationId);}
        return paused;
    };

    return {
        port: {
            beforeStatement: async (event: DslBeforeStatementEvent) => {
                if (mode !== 'step' && !breakpoints.has(event.location.path)) {return undefined;}
                const paused = await pause(Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: 'statement',
                    location: event.location,
                    scope: event.scope,
                    statement: event.statement,
                    frames: event.frames,
                }));
                return paused.statementOverride
                    ? Object.freeze({statement: paused.statementOverride})
                    : undefined;
            },
            beforeEffect: async (event: DslBeforeEffectEvent) => {
                const isBarrier = barrierOn.has(event.effect.semantics.reversibility);
                if (!isBarrier && !options.breakBeforeEffects) {return undefined;}
                await pause(Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: isBarrier ? 'barrier' as const : 'effect' as const,
                    location: event.location,
                    scope: event.scope,
                    effect: event.effect,
                }));
                return undefined;
            },
            onFailure: async (event: DslFailureEvent) => {
                if (!options.breakOnFailure) {return;}
                await pause(Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: 'failure',
                    location: event.location,
                    scope: event.scope,
                    failure: event.failure,
                }));
            },
        },
        waitForPause: async () => {
            const pause = queued.shift();
            if (pause) {return pause;}
            return await new Promise<PausedDslExecution>((resolve) => {waiters.push(resolve);});
        },
        continue: (continuationId) => {release(continuationId, 'continue');},
        step: (continuationId) => {release(continuationId, 'step');},
        patchStatement: (continuationId, statement) => {
            if (active?.pause.continuationId !== continuationId) {
                throw new Error(`DSL continuation is not paused: ${continuationId}`);
            }
            if (active.pause.reason !== 'statement') {
                throw new Error(`DSL continuation is not paused before a statement: ${continuationId}`);
            }
            active.statementOverride = structuredClone(statement);
            active.pause = Object.freeze({
                ...active.pause,
                location: Object.freeze({...active.pause.location, kind: statement.kind}),
                statement: structuredClone(statement),
            });
        },
        crossBarrier: (continuationId) => {release(continuationId, 'step', true);},
        abort: (continuationId) => {
            if (active?.pause.continuationId !== continuationId) {
                throw new Error(`DSL continuation is not paused: ${continuationId}`);
            }
            active.resume('abort');
        },
    };
};
