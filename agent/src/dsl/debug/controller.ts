import crypto from 'node:crypto';
import type {
    DslBeforeStatementEvent,
    DslDebugController,
    PausedDslExecution,
} from './contracts';

export type CreateDslDebugControllerOptions = {
    initialMode?: 'continue' | 'step';
    breakpoints?: readonly string[];
};

type ActivePause = {
    pause: PausedDslExecution;
    resume: () => void;
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
        active.resume();
    };

    return {
        port: {
            beforeStatement: async (event: DslBeforeStatementEvent) => {
                if (mode !== 'step' && !breakpoints.has(event.location.path)) {return;}
                if (active) {throw new Error('DSL debugger already has an active continuation');}
                const pause: PausedDslExecution = Object.freeze({
                    continuationId: crypto.randomUUID(),
                    reason: 'statement',
                    location: event.location,
                    scope: event.scope,
                });
                await new Promise<void>((resolve) => {
                    active = {pause, resume: resolve};
                    publish(pause);
                });
                active = null;
            },
        },
        waitForPause: async () => {
            const pause = queued.shift();
            if (pause) {return pause;}
            return await new Promise<PausedDslExecution>((resolve) => {waiters.push(resolve);});
        },
        continue: (continuationId) => {release(continuationId, 'continue');},
        step: (continuationId) => {release(continuationId, 'step');},
    };
};
