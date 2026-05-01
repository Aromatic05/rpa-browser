import test from 'node:test';
import assert from 'node:assert/strict';
import { createControlRouter } from '../../src/control/router';
import type { RunStepsDeps } from '../../src/runner/run_steps';

const createDeps = (): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-router',
                tabId: 'tab-router',
                tabName: 'tk-router',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () => ({}),
        } as any,
    }) as RunStepsDeps;

test('router handles agent.ping', async () => {
    const router = createControlRouter({ deps: createDeps() });

    const response = await router.handle({
        id: '1',
        method: 'agent.ping',
        params: {},
    });

    assert.equal(response.id, '1');
    assert.equal(response.ok, true);
    assert.equal(typeof (response.ok ? response.result?.ts : undefined), 'number');
});

test('router returns method not found for unknown methods', async () => {
    const router = createControlRouter({ deps: createDeps() });

    const response = await router.handle({
        id: '2',
        method: 'agent.unknown',
        params: {},
    });

    assert.deepEqual(response, {
        id: '2',
        ok: false,
        error: {
            code: 'ERR_CONTROL_METHOD_NOT_FOUND',
            message: 'control method not found: agent.unknown',
        },
    });
});

test('router converts handler errors into failed responses', async () => {
    const router = createControlRouter({ deps: createDeps() });

    const response = await router.handle({
        id: '3',
        method: 'dsl.run',
        params: {},
    });

    assert.equal(response.id, '3');
    assert.equal(response.ok, false);
    if (response.ok) {
        assert.fail('expected failed response');
    }
    assert.equal(response.error.code, 'ERR_CONTROL_BAD_REQUEST');
});
