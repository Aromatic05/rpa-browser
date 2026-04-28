import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../src/dsl';
import type { Logger } from '../../../src/logging/logger';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';

type LogCall = {
    level: 'debug' | 'error';
    event: string;
    payload: Record<string, unknown>;
};

const createDeps = (): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceId: 'ws-dsl',
                tabId: 'tab-dsl',
                tabToken: 'tk-dsl',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.snapshot': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: { snapshot: true },
                    }),
                }) as any,
        } as any,
    }) as RunStepsDeps;

const createMockLogger = (calls: LogCall[]): Logger => {
    const logger = ((...args: unknown[]) => {
        calls.push({ level: 'debug', event: String(args[0]), payload: (args[1] || {}) as Record<string, unknown> });
    }) as Logger;
    logger.debug = (...args: unknown[]) => {
        calls.push({ level: 'debug', event: String(args[0]), payload: (args[1] || {}) as Record<string, unknown> });
    };
    logger.info = () => {};
    logger.warning = () => {};
    logger.warn = () => {};
    logger.error = (...args: unknown[]) => {
        calls.push({ level: 'error', event: String(args[0]), payload: (args[1] || {}) as Record<string, unknown> });
    };
    return logger;
};

test('runDsl writes stmt and step trace logs', async () => {
    const logs: LogCall[] = [];
    const logger = createMockLogger(logs);
    const program = normalizeDsl(
        parseDsl(`
            snapshot
        `),
    );

    await runDsl(program, {
        workspaceId: 'ws-dsl',
        deps: createDeps(),
        logger,
    });

    const events = logs.map((entry) => entry.event);
    assert.equal(events.includes('dsl.stmt.start'), true);
    assert.equal(events.includes('dsl.step.emit'), true);
    assert.equal(events.includes('dsl.step.result'), true);
    assert.equal(events.includes('dsl.stmt.end'), true);
});
