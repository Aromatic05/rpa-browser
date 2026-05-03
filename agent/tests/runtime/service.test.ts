import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createWorkspaceServiceLifecycle,
    type WorkspaceService,
} from '../../src/runtime/service';

const createStubService = (
    name: 'mcp',
    workspaceName: string,
): WorkspaceService => {
    let status: 'stopped' | 'starting' | 'running' | 'stopping' | 'failed' = 'stopped';
    let port: number | null = null;

    return {
        name,
        workspaceName,
        async start() {
            status = 'starting';
            port = 12345;
            status = 'running';
            return { serviceName: name, workspaceName, port, status };
        },
        async stop() {
            status = 'stopping';
            port = null;
            status = 'stopped';
            return { serviceName: name, workspaceName, status };
        },
        status() {
            return { serviceName: name, workspaceName, port, status };
        },
    };
};

test('createWorkspaceServiceLifecycle starts a registered service', async () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    const result = await lifecycle.start('mcp');
    assert.equal(result.serviceName, 'mcp');
    assert.equal(result.workspaceName, 'test-ws');
    assert.equal(result.port, 12345);
    assert.equal(result.status, 'running');
});

test('createWorkspaceServiceLifecycle stops a running service', async () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    const stopResult = await lifecycle.stop('mcp');
    assert.equal(stopResult.serviceName, 'mcp');
    assert.equal(stopResult.status, 'stopped');
});

test('createWorkspaceServiceLifecycle status returns stopped for unregistered service', () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    const result = lifecycle.status('mcp');
    assert.equal(result.serviceName, 'mcp');
    assert.equal(result.workspaceName, 'test-ws');
    assert.equal(result.port, null);
    assert.equal(result.status, 'stopped');
});

test('createWorkspaceServiceLifecycle status returns running after start', async () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    const result = lifecycle.status('mcp');
    assert.equal(result.status, 'running');
    assert.equal(result.port, 12345);
});

test('createWorkspaceServiceLifecycle throws on start of unregistered service', async () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    await assert.rejects(
        () => lifecycle.start('mcp'),
        /service not registered/,
    );
});

test('createWorkspaceServiceLifecycle reports service status after stop', async () => {
    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    await lifecycle.stop('mcp');
    const result = lifecycle.status('mcp');
    assert.equal(result.status, 'stopped');
    assert.equal(result.port, null);
});

test('service status transitions: stopped -> starting -> running -> stopping -> stopped', async () => {
    const transitions: string[] = [];
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            transitions.push('starting');
            transitions.push('running');
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 1, status: 'running' };
        },
        async stop() {
            transitions.push('stopping');
            transitions.push('stopped');
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: null, status: 'stopped' };
        },
    };

    const lifecycle = createWorkspaceServiceLifecycle('test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    await lifecycle.stop('mcp');
    assert.deepEqual(transitions, ['starting', 'running', 'stopping', 'stopped']);
});
