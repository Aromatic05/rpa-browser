import crypto from 'node:crypto';
import {DslDebugAbortError} from './errors';
import type {
    DslBeforeEffectEvent,
    DslBeforeStatementEvent,
    DslDebugController,
    DslFailureEvent,
    PausedDslExecution,
} from './contracts';

export type CreateDslDebugControllerOptions = {
    initialMode?: 'continue' | 'step';
    breakpoints?: readonly string[];
    breakBeforeEffects?: boolean;
    breakOnFailure?: boolean;
};

type ActivePause = {
    pause: PausedDslExecution;
    resume: (action: 'resume' | 'abort') => void;
};

export const createDslDebugController = (
    options: CreateDslDebugControllerOptions = {},
): DslDebugController => {
    const breakpoints = new Set(options.breakpoints ?? []);
    const queued: PausedDslExecution[] = [];
    const waiters: Array<(pause: PausedDslExecution) => void> = [];
    let mode = options.initialMode ?? 'continue';
    let active: ActivePause | null = null;

    const publish = (pause: PausedDslExecution): void => {
        const waiter = waiters.shift();
        if (waiter) {waiter(pause); return;}
        queued.push(pause);
    };

    const release = (continuationId: string, nextMode: 'continue' | 'step'): void => {
        if (active?.pause.continuationId !== continuationId) {
            throw new Error(`DSL continuation is not paused: ${continuationId}`);
        }
        mode = nextMode;
        active.resume('resume');
    };

    const pause = async (value: PausedDslExecution): Promise<void> => {
        if (active) {throw new Error('DSL debugger already has an active continuation');}
        const action = await new Promise<'resume' | 'abort'>((resolve) => {
            active = {pause: value, resume: resolve};
            publish(value);
        });
        active = null;
        if (action === 'abort') {throw new DslDebugAbortError(value.continuationId);}
    };

    return {
        port: {
            beforeStatement: async (event: DslBeforeStatementEvent) => {
                if (mode !== 'step' && !breakpoints.has(event.location.path)) {return;}
                await pause(Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: 'statement',
                    location: event.location,
                    scope: event.scope,
                }));
            },
            beforeEffect: async (event: DslBeforeEffectEvent) => {
                if (!options.breakBeforeEffects) {return;}
                await pause(Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: 'effect',
                    location: event.location,
                    scope: event.scope,
                    effect: event.effect,
                }));
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
        abort: (continuationId) => {
            if (active?.pause.continuationId !== continuationId) {
                throw new Error(`DSL continuation is not paused: ${continuationId}`);
            }
            active.resume('abort');
        },
    };
};
