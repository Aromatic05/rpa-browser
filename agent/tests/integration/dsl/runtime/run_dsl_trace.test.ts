import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl, parseDsl, runDsl } from '../../../../src/program/dsl';
import type { Logger } from '../../../../src/logging/logger';
import type { RunStepsDeps } from '../../../../src/automation/runner/run_steps';
import type { StepUnion } from '../../../../src/automation/runner/steps/types';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

type LogCall = {
    level: 'debug' | 'error';
    event: string;
    payload: Record<string, unknown>;
};

const createDeps = (): RunStepsDeps =>
    completeRunStepsDeps({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-dsl',
                tabName: 'tk-dsl',
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
                    'browser.query': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: {kind: 'value', value: 'correct horse battery staple'},
                    }),
                }) as any,
        } as any,
    });

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
        workspaceName: 'ws-dsl',
        deps: createDeps(),
        logger,
    });

    const events = logs.map((entry) => entry.event);
    assert.equal(events.includes('dsl.stmt.start'), true);
    assert.equal(events.includes('dsl.step.emit'), true);
    assert.equal(events.includes('dsl.step.result'), true);
    assert.equal(events.includes('dsl.stmt.end'), true);
});

test('runDsl scope logs expose value shape without string contents', async () => {
    const logs: LogCall[] = [];
    const logger = createMockLogger(logs);
    const program = normalizeDsl(parseDsl('let password = query entity "secret.value" current'));

    await runDsl(program, {
        workspaceName: 'ws-dsl',
        deps: createDeps(),
        logger,
    });

    const write = logs.find((entry) => entry.event === 'dsl.scope.write');
    assert.deepEqual(write?.payload.valuePreview, {type: 'string', length: 28});
    assert.equal(JSON.stringify(logs).includes('correct horse battery staple'), false);
});
