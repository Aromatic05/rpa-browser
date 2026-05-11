import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createControlServer, sendControlEval } from '../../src/control';

const createTestEndpoint = (): string =>
    process.platform === 'win32'
        ? `\\\\.\\pipe\\rpa-browser-agent-test-${process.pid}-${Date.now()}`
        : path.join(os.tmpdir(), `rpa-browser-agent-test-${process.pid}-${Date.now()}.sock`);

test('sendControlEval can call eval over control server', async () => {
    const prev = process.env.RPA_CONTROL_EVAL;
    process.env.RPA_CONTROL_EVAL = '1';
    const server = createControlServer({
        endpoint: createTestEndpoint(),
        evalContext: {
            deps: {} as any,
            workspaceRegistry: { getWorkspace: () => null } as any,
            config: {} as any,
            dispatch: async (action) => action,
            resolveWorkspace: () => null,
        },
    });

    await server.start();
    try {
        const response = await sendControlEval(
            {
                source: 'return 40 + 2',
            },
            { endpoint: server.endpoint },
        );

        assert.equal(response.ok, true);
        if (!response.ok) {
            assert.fail('expected ok response');
        }
        assert.equal(response.result, 42);
    } finally {
        await server.close();
        if (typeof prev === 'string') {
            process.env.RPA_CONTROL_EVAL = prev;
        } else {
            delete process.env.RPA_CONTROL_EVAL;
        }
    }
});
