import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createControlServer, sendControlRequest } from '../../src/control';
import type { RunStepsDeps } from '../../src/runner/run_steps';

const createDeps = (): RunStepsDeps =>
    ({
        runtime: {
            ensureActivePage: async () => ({
                workspaceName: 'ws-client',
                tabName: 'tab-client',
                tabName: 'tk-client',
                traceCtx: { cache: {} },
            }),
        },
        config: {} as any,
        pluginHost: {
            getExecutors: () => ({}),
        } as any,
    }) as RunStepsDeps;

const createTestEndpoint = (): string =>
    process.platform === 'win32'
        ? `\\\\.\\pipe\\rpa-browser-agent-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `rpa-browser-agent-test-${process.pid}-${Date.now()}.sock`);

test('sendControlRequest can call agent.ping over the control server', async () => {
    const server = createControlServer({
        endpoint: createTestEndpoint(),
        deps: createDeps(),
    });

    await server.start();
    try {
        const response = await sendControlRequest(
            {
                method: 'agent.ping',
                params: {},
            },
            { endpoint: server.endpoint },
        );

        assert.equal(response.ok, true);
        if (!response.ok) {
            assert.fail('expected ok response');
        }
        assert.equal(typeof response.result?.ts, 'number');
    } finally {
        await server.close();
        await server.close();
    }
});
