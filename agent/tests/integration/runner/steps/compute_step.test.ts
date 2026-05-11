import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { executeBrowserCompute } from '../../../src/runner/steps/executors/compute';
import type { Step } from '../../../src/runner/steps/types';

const createDeps = (cache: Record<string, unknown> = {}): RunStepsDeps => ({
    runtime: {
        ensureActivePage: async () => ({
            traceCtx: { cache },
        }),
    } as any,
    config: {} as any,
    pluginHost: {} as any,
});

test('browser.compute supports len and nested get/eq/not', async () => {
    const step: Step<'browser.compute'> = {
        id: 'c1',
        name: 'browser.compute',
        args: {
            expr: {
                op: 'not',
                args: [
                    {
                        op: 'eq',
                        args: [
                            {
                                op: 'get',
                                args: [{ literal: [10, 20, 30] }, { literal: 1 }],
                            },
                            { literal: 10 },
                        ],
                    },
                ],
            },
        },
    };

    const result = await executeBrowserCompute(step, createDeps(), 'ws-1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any).value, true);
});

test('browser.compute supports ref path from previous step results', async () => {
    const step: Step<'browser.compute'> = {
        id: 'c2',
        name: 'browser.compute',
        args: {
            expr: {
                op: 'len',
                args: [{ ref: { path: 'steps.q1.data.nodeIds' } }],
            },
        },
    };

    const result = await executeBrowserCompute(
        step,
        createDeps({
            runnerStepResults: {
                q1: {
                    ok: true,
                    data: {
                        nodeIds: ['n1', 'n2'],
                    },
                },
            },
        }),
        'ws-1',
    );
    assert.equal(result.ok, true);
    assert.equal((result.data as any).value, 2);
});

test('browser.compute supports exists/first/and/or', async () => {
    const step: Step<'browser.compute'> = {
        id: 'c3',
        name: 'browser.compute',
        args: {
            expr: {
                op: 'and',
                args: [
                    {
                        op: 'exists',
                        args: [{ literal: [1] }],
                    },
                    {
                        op: 'or',
                        args: [
                            {
                                op: 'eq',
                                args: [{ op: 'first', args: [{ literal: ['x'] }] }, { literal: 'y' }],
                            },
                            { literal: true },
                        ],
                    },
                ],
            },
        },
    };
    const result = await executeBrowserCompute(step, createDeps(), 'ws-1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any).value, true);
});

test('browser.compute fails on invalid op', async () => {
    const step = {
        id: 'c4',
        name: 'browser.compute',
        args: {
            expr: {
                op: 'bad',
                args: [],
            },
        },
    } as unknown as Step<'browser.compute'>;
    const result = await executeBrowserCompute(step, createDeps(), 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});
