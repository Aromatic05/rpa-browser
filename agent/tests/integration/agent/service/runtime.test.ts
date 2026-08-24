import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';

const result = {
    provider: 'test',
    model: 'model',
    text: 'ok',
    trace: {
        metrics: {
            turns: 1,
            toolCalls: 0,
            readCalls: 0,
            controlCalls: 0,
            effectCalls: 0,
            failedToolCalls: 0,
            postErrorEffectCalls: 0,
        },
        tools: [],
    },
};

test('workspace agent service exposes an HTTP endpoint parallel to MCP', async () => {
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-test',
        portAllocator: createPortAllocator(23000),
        runner: {run: async () => result},
    });
    const started = await service.start();
    try {
        assert.equal(started.serviceName, 'agent');
        assert.equal(started.status, 'running');
        const health = await fetch(`http://127.0.0.1:${String(started.port)}/health`);
        assert.equal(health.status, 200);
        assert.deepEqual(await health.json(), {
            ok: true,
            serviceName: 'agent',
            workspaceName: 'agent-service-test',
            agentPath: '/agent',
        });

        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), result);
    } finally {
        const stopped = await service.stop();
        assert.equal(stopped.status, 'stopped');
    }
});

test('workspace agent service rejects malformed run requests at the endpoint boundary', async () => {
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-bad-request',
        portAllocator: createPortAllocator(23100),
        runner: {run: async () => result},
    });
    const started = await service.start();
    try {
        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 400);
        assert.deepEqual(await response.json(), {error: 'prompt is required'});
    } finally {
        await service.stop();
    }
});
