import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkspaceService, WorkspaceServiceName, WorkspaceServiceStartResult, WorkspaceServiceStopResult, WorkspaceServiceStatusResult } from '../../src/runtime/service/types';

const createServiceLifecycle = (workspaceName: string) => {
    const services = new Map<WorkspaceServiceName, WorkspaceService>();
    return {
        register(service: WorkspaceService) { services.set(service.name, service); },
        async start(serviceName: WorkspaceServiceName): Promise<WorkspaceServiceStartResult> {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.start();
        },
        async stop(serviceName: WorkspaceServiceName): Promise<WorkspaceServiceStopResult> {
            const service = services.get(serviceName);
            if (!service) { throw new Error(`service not registered: ${serviceName}`); }
            return await service.stop();
        },
        status(serviceName: WorkspaceServiceName): WorkspaceServiceStatusResult {
            const service = services.get(serviceName);
            if (!service) { return { serviceName, workspaceName, port: null, status: 'stopped' as const }; }
            return service.status();
        },
    };
};

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

test('createServiceLifecycle starts a registered service', async () => {
    const lifecycle = createServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    const result = await lifecycle.start('mcp');
    assert.equal(result.serviceName, 'mcp');
    assert.equal(result.workspaceName, 'test-ws');
    assert.equal(result.port, 12345);
    assert.equal(result.status, 'running');
});

test('createServiceLifecycle stops a running service', async () => {
    const lifecycle = createServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    const stopResult = await lifecycle.stop('mcp');
    assert.equal(stopResult.serviceName, 'mcp');
    assert.equal(stopResult.status, 'stopped');
});

test('createServiceLifecycle status returns stopped for unregistered service', () => {
    const lifecycle = createServiceLifecycle('test-ws');
    const result = lifecycle.status('mcp');
    assert.equal(result.serviceName, 'mcp');
    assert.equal(result.workspaceName, 'test-ws');
    assert.equal(result.port, null);
    assert.equal(result.status, 'stopped');
});

test('createServiceLifecycle status returns running after start', async () => {
    const lifecycle = createServiceLifecycle('test-ws');
    const service = createStubService('mcp', 'test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    const result = lifecycle.status('mcp');
    assert.equal(result.status, 'running');
    assert.equal(result.port, 12345);
});

test('createServiceLifecycle throws on start of unregistered service', async () => {
    const lifecycle = createServiceLifecycle('test-ws');
    await assert.rejects(
        () => lifecycle.start('mcp'),
        /service not registered/,
    );
});

test('createServiceLifecycle reports service status after stop', async () => {
    const lifecycle = createServiceLifecycle('test-ws');
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

    const lifecycle = createServiceLifecycle('test-ws');
    lifecycle.register(service);

    await lifecycle.start('mcp');
    await lifecycle.stop('mcp');
    assert.deepEqual(transitions, ['starting', 'running', 'stopping', 'stopped']);
});
