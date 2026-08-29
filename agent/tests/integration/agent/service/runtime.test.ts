import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createWorkspaceAgentService} from '../../../../src/agent/service/runtime';
import type {AgentRunResult} from '../../../../src/agent/execution/types';

const result: AgentRunResult = {
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

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
};

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

test('agent run endpoint returns a stable session id header while preserving the body', async () => {
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-session-id',
        portAllocator: createPortAllocator(23200),
        runner: {run: async () => result},
    });
    const started = await service.start();
    try {
        const response = await fetch(`http://127.0.0.1:${String(started.port)}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), result);

        const sessionId = response.headers.get('x-session-id');
        assert.equal(typeof sessionId, 'string');
        assert.ok(sessionId && sessionId.length > 0);

        const list = await fetch(`http://127.0.0.1:${String(started.port)}/agent/sessions`);
        const listPayload = await list.json() as {sessions: Array<{sessionId: string}>};
        assert.equal(listPayload.sessions.length, 1);
        assert.equal(listPayload.sessions[0].sessionId, sessionId);
    } finally {
        await service.stop();
    }
});

test('agent session endpoints track start, status, and cancel over the HTTP boundary', async () => {
    const pending = deferred<AgentRunResult>();
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-sessions',
        portAllocator: createPortAllocator(23300),
        runner: {run: () => pending.promise},
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}/agent/sessions`;
        const start = await fetch(base, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'hello', provider: 'test', model: 'model'}),
        });
        assert.equal(start.status, 202);
        const snapshot = await start.json() as {sessionId: string; state: string};
        assert.equal(snapshot.state, 'running');
        assert.equal(typeof snapshot.sessionId, 'string');

        const status = await fetch(`${base}/${snapshot.sessionId}`);
        assert.equal(status.status, 200);
        assert.equal(((await status.json()) as {state: string}).state, 'running');

        const cancel = await fetch(`${base}/${snapshot.sessionId}/cancel`, {method: 'POST'});
        assert.equal(cancel.status, 200);
        assert.equal(((await cancel.json()) as {state: string}).state, 'cancelled');

        await flush();
        const after = await fetch(`${base}/${snapshot.sessionId}`);
        assert.equal(((await after.json()) as {state: string}).state, 'cancelled');
    } finally {
        await service.stop();
    }
});

test('agent session endpoints return 404 for unknown sessions', async () => {
    const service = createWorkspaceAgentService({
        workspaceName: 'agent-service-missing-session',
        portAllocator: createPortAllocator(23400),
        runner: {run: async () => result},
    });
    const started = await service.start();
    try {
        const base = `http://127.0.0.1:${String(started.port)}/agent/sessions`;
        const status = await fetch(`${base}/missing`);
        assert.equal(status.status, 404);
        const cancel = await fetch(`${base}/missing/cancel`, {method: 'POST'});
        assert.equal(cancel.status, 404);
    } finally {
        await service.stop();
    }
});
