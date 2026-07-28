import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createMcpControl } from '../../../src/mcp/control';
import { createPortAllocator } from '../../../src/runtime/service/ports';
import { createWorkspaceToolHandlers } from '../../../src/mcp/tool_handlers';
import { createWorkspaceTabs } from '../../../src/runtime/workspace/tabs';
import type { RuntimeWorkspace } from '../../../src/runtime/workspace/workspace';
import type { WorkspaceRegistry } from '../../../src/runtime/workspace/registry';
import type { WorkspaceService } from '../../../src/runtime/service/types';
import type { Action } from '../../../src/actions/action_protocol';
import type { Workflow } from '../../../src/workflow';

const stubWorkflow = (name: string) => ({ name }) as Workflow;

const stubAction = (type: string, workspaceName = 'test-ws'): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName,
    payload: {},
    at: Date.now(),
});

const createService = (overrides: Partial<WorkspaceService> = {}): WorkspaceService => ({
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
    ...overrides,
});

const createWorkspace = (service = createService()): { workspace: RuntimeWorkspace; control: ReturnType<typeof createMcpControl> } => {
    const control = createMcpControl(service);
    const tabs = createWorkspaceTabs({
        awaitPageBinding: async () => { throw new Error('awaitPageBinding not stubbed in test'); },
        createPageBinding: async () => { throw new Error('createPageBinding not stubbed in test'); },
    });
    const workspace = {
        name: service.workspaceName,
        workflow: stubWorkflow(service.workspaceName),
        browserSession: null,
        tabs,
        record: null,
        dsl: null,
        checkpoint: null,
        runner: null,
        mcp: control,
        router: null,
        state: 'idle',
        createdAt: Date.now(),
        updatedAt: Date.now(),
    } as unknown as RuntimeWorkspace;
    return { workspace, control };
};

const invoke = async (
    control: ReturnType<typeof createMcpControl>,
    workspace: RuntimeWorkspace,
    type: string,
) => await control.handle({
    action: stubAction(type, workspace.name),
    workspace,
    workspaceRegistry: {} as WorkspaceRegistry,
});

test('mcp.start returns workspaceName, serviceName, port, status', async () => {
    const { workspace, control } = createWorkspace();
    const result = await invoke(control, workspace, 'mcp.start');
    assert.deepEqual(result.reply.payload, {
        workspaceName: 'test-ws',
        serviceName: 'mcp',
        port: 9999,
        status: 'running',
    });
});

test('mcp.stop returns workspaceName, serviceName, status', async () => {
    const { workspace, control } = createWorkspace();
    const result = await invoke(control, workspace, 'mcp.stop');
    assert.deepEqual(result.reply.payload, {
        workspaceName: 'test-ws',
        serviceName: 'mcp',
        status: 'stopped',
    });
});

test('mcp.status returns workspaceName, serviceName, port, status', async () => {
    const service = createService({
        status: () => ({ serviceName: 'mcp', workspaceName: 'test-ws', port: 9999, status: 'running' }),
    });
    const { workspace, control } = createWorkspace(service);
    const result = await invoke(control, workspace, 'mcp.status');
    assert.deepEqual(result.reply.payload, {
        workspaceName: 'test-ws',
        serviceName: 'mcp',
        port: 9999,
        status: 'running',
    });
});

test('mcp.start propagates service startup failure', async () => {
    const service = createService({
        start: async () => { throw new Error('port allocation failed'); },
    });
    const { workspace, control } = createWorkspace(service);
    await assert.rejects(() => invoke(control, workspace, 'mcp.start'), /port allocation failed/);
});

test('createWorkspaceToolHandlers returns browser tools without registries', () => {
    const { workspace } = createWorkspace();
    const handlers = createWorkspaceToolHandlers({ workspace });
    const toolNames = Object.keys(handlers);
    for (const toolName of ['browser.goto', 'browser.click', 'browser.snapshot', 'browser.fill', 'browser.type', 'browser.batch']) {
        assert.equal(typeof handlers[toolName], 'function', `missing handler: ${toolName}`);
    }
    assert.ok(toolNames.length > 10);
});

test('port allocator releases workspace MCP port', async () => {
    const allocator = createPortAllocator(19000);
    const port = await allocator.allocate('test-ws', 'mcp');
    assert.equal(allocator.getPort('test-ws', 'mcp'), port);
    allocator.release('test-ws', 'mcp');
    assert.equal(allocator.getPort('test-ws', 'mcp'), null);
});
