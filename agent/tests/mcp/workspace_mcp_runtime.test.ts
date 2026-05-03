import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMcpControl } from '../../src/mcp/control';
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
import { createPortAllocator } from '../../src/runtime/service/ports';
import { createWorkspaceToolHandlers } from '../../src/mcp/tool_handlers';
import { createWorkspaceTabs } from '../../src/runtime/workspace/tabs';
import type { RuntimeWorkspace } from '../../src/runtime/workspace_registry';
import type { Action } from '../../src/actions/action_protocol';

const stubAction = (type: string, opts?: { workspaceName?: string; payload?: Record<string, unknown> }): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: opts?.workspaceName,
    payload: opts?.payload ?? {},
    at: Date.now(),
});

const createMinimalWorkspace = (name: string): RuntimeWorkspace => ({
    name,
    workflow: { name, steps: [], checkpoints: [], recording: null, entityRules: { rules: [], bundles: [] } },
    runner: null,
    tabRegistry: createWorkspaceTabs({ getPage: async () => { throw new Error('getPage not stubbed in test'); } }),
    controls: {} as RuntimeWorkspace['controls'],
    serviceLifecycle: createServiceLifecycle(name),
    getPage: async () => {
        throw new Error('getPage not stubbed in test');
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
});

test('mcp.start returns workspaceName, serviceName, port, status', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 9999, status: 'running' };
        },
        async stop() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: null, status: 'stopped' };
        },
    };
    ws.serviceLifecycle.register(service);

    const control = createMcpControl(() => ws.serviceLifecycle);
    const result = await control.handle(stubAction('mcp.start', { workspaceName: 'test-ws' }), ws);

    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.port, 9999);
    assert.equal(payload.status, 'running');
});

test('mcp.stop returns workspaceName, serviceName, status', async () => {
    const ws = createMinimalWorkspace('test-ws');
    let running = false;
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            running = true;
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 9999, status: 'running' };
        },
        async stop() {
            running = false;
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' };
        },
        status() {
            return {
                serviceName: 'mcp',
                workspaceName: 'test-ws',
                port: running ? 9999 : null,
                status: running ? 'running' : 'stopped',
            };
        },
    };
    ws.serviceLifecycle.register(service);

    const control = createMcpControl(() => ws.serviceLifecycle);
    await control.handle(stubAction('mcp.start', { workspaceName: 'test-ws' }), ws);
    const result = await control.handle(stubAction('mcp.stop', { workspaceName: 'test-ws' }), ws);

    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.status, 'stopped');
});

test('mcp.status returns workspaceName, serviceName, port, status', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 9999, status: 'running' };
        },
        async stop() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: 9999, status: 'running' };
        },
    };
    ws.serviceLifecycle.register(service);
    await ws.serviceLifecycle.start('mcp');

    const control = createMcpControl(() => ws.serviceLifecycle);
    const result = await control.handle(stubAction('mcp.status', { workspaceName: 'test-ws' }), ws);

    const payload = result.reply.payload as Record<string, unknown>;
    assert.equal(payload.workspaceName, 'test-ws');
    assert.equal(payload.serviceName, 'mcp');
    assert.equal(payload.port, 9999);
    assert.equal(payload.status, 'running');
});

test('mcp.start rejects payload.workspaceName', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const control = createMcpControl(() => ws.serviceLifecycle);

    await assert.rejects(
        () => control.handle(stubAction('mcp.start', { payload: { workspaceName: 'test-ws' } }), ws),
        /mcp actions do not accept payload.workspaceName/,
    );
});

test('mcp.stop rejects payload.workspaceName', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const control = createMcpControl(() => ws.serviceLifecycle);

    await assert.rejects(
        () => control.handle(stubAction('mcp.stop', { payload: { workspaceName: 'test-ws' } }), ws),
        /mcp actions do not accept payload.workspaceName/,
    );
});

test('mcp.status rejects payload.workspaceName', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const control = createMcpControl(() => ws.serviceLifecycle);

    await assert.rejects(
        () => control.handle(stubAction('mcp.status', { payload: { workspaceName: 'test-ws' } }), ws),
        /mcp actions do not accept payload.workspaceName/,
    );
});

test('createWorkspaceToolHandlers returns all browser.* tool handlers without workspaceRegistry', () => {
    const ws = createMinimalWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({ workspace: ws });

    const toolNames = Object.keys(handlers).sort();
    assert.ok(toolNames.includes('browser.goto'));
    assert.ok(toolNames.includes('browser.click'));
    assert.ok(toolNames.includes('browser.snapshot'));
    assert.ok(toolNames.includes('browser.fill'));
    assert.ok(toolNames.includes('browser.type'));
    assert.ok(toolNames.includes('browser.batch'));
    assert.ok(toolNames.length > 10);
});

test('createWorkspaceToolHandlers does not require pageRegistry', () => {
    const ws = createMinimalWorkspace('test-ws');
    const deps = { workspace: ws };
    const handlers = createWorkspaceToolHandlers(deps);
    assert.ok(typeof handlers['browser.goto'] === 'function');
    assert.ok(typeof handlers['browser.click'] === 'function');
});

test('browser.* MCP tool names are preserved in workspace handlers', () => {
    const ws = createMinimalWorkspace('test-ws');
    const handlers = createWorkspaceToolHandlers({ workspace: ws });
    const knownTools = [
        'browser.goto',
        'browser.go_back',
        'browser.reload',
        'browser.click',
        'browser.fill',
        'browser.snapshot',
        'browser.capture_resolve',
    ];
    for (const name of knownTools) {
        assert.ok(name in handlers, `workspace handler missing tool: ${name}`);
    }
});

test('port allocator releases port after stop lifecycle', async () => {
    const allocator = createPortAllocator(19000);
    const port = await allocator.allocate('test-ws', 'mcp');
    assert.ok(typeof port === 'number');
    assert.equal(allocator.getPort('test-ws', 'mcp'), port);

    allocator.release('test-ws', 'mcp');
    assert.equal(allocator.getPort('test-ws', 'mcp'), null);
});

test('mcp.start failure propagates through lifecycle', async () => {
    const ws = createMinimalWorkspace('test-ws');
    const service: WorkspaceService = {
        name: 'mcp',
        workspaceName: 'test-ws',
        async start() {
            throw new Error('port allocation failed');
        },
        async stop() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', status: 'stopped' };
        },
        status() {
            return { serviceName: 'mcp', workspaceName: 'test-ws', port: null, status: 'stopped' };
        },
    };
    ws.serviceLifecycle.register(service);

    const control = createMcpControl(() => ws.serviceLifecycle);
    await assert.rejects(
        () => control.handle(stubAction('mcp.start', { workspaceName: 'test-ws' }), ws),
        /port allocation failed/,
    );
});
