import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkspaceRouter } from '../../src/runtime/workspace/router';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';
import type { McpControl } from '../../src/mcp/control';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: crypto.randomUUID(), type, ...extra });

// ── Router: domain dispatch ──

test('router dispatches record.* actions to recordControl', async () => {
    const dispatched: string[] = [];
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async ({ action: a }) => { dispatched.push(a.type); return { reply: action(`${a.type}.result`), events: [] }; } } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = {} as any;

    await router.handle(action('record.start'), ws, reg);
    await router.handle(action('record.stop'), ws, reg);
    await router.handle(action('play.start'), ws, reg);
    assert.deepEqual(dispatched, ['record.start', 'record.stop', 'play.start']);
});

test('router dispatches dsl.* actions to dslControl', async () => {
    const dispatched: string[] = [];
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async ({ action: a }) => { dispatched.push(a.type); return { reply: action(`${a.type}.result`), events: [] }; } } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = {} as any;

    await router.handle(action('dsl.methods'), ws, reg);
    await router.handle(action('dsl.execute'), ws, reg);
    assert.deepEqual(dispatched, ['dsl.methods', 'dsl.execute']);
});

test('router dispatches task.run.* actions to runnerControl', async () => {
    const dispatched: string[] = [];
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async ({ action: a }) => { dispatched.push(a.type); return { reply: action(`${a.type}.result`), events: [] }; } } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = {} as any;

    await router.handle(action('task.run.start'), ws, reg);
    await router.handle(action('task.run.stop'), ws, reg);
    assert.deepEqual(dispatched, ['task.run.start', 'task.run.stop']);
});

test('router dispatches mcp.start/mcp.stop/mcp.status to workspace.mcp directly', async () => {
    const mcpCalls: string[] = [];
    const mcp: McpControl = {
        start: async () => { mcpCalls.push('start'); return { serviceName: 'mcp', workspaceName: 'ws-1', port: 1, status: 'running' }; },
        stop: async () => { mcpCalls.push('stop'); return { serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' }; },
        status: () => { mcpCalls.push('status'); return { serviceName: 'mcp', workspaceName: 'ws-1', port: null, status: 'stopped' }; },
    };
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {}, mcp } as any;
    const reg = {} as any;

    await router.handle(action('mcp.start'), ws, reg);
    await router.handle(action('mcp.stop'), ws, reg);
    router.handle(action('mcp.status'), ws, reg);
    assert.deepEqual(mcpCalls, ['start', 'stop', 'status']);
});

test('router throws on unsupported mcp action prefix', async () => {
    const mcp: McpControl = {
        start: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: 1, status: 'running' }),
        stop: async () => ({ serviceName: 'mcp', workspaceName: 'ws-1', status: 'stopped' }),
        status: () => ({ serviceName: 'mcp', workspaceName: 'ws-1', port: null, status: 'stopped' }),
    };
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {}, mcp } as any;
    const reg = {} as any;

    await assert.rejects(
        () => router.handle(action('mcp.unknown', { payload: {} }), ws, reg),
        /unsupported mcp action/,
    );
});

test('router throws on completely unsupported action type', async () => {
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = {} as any;

    await assert.rejects(
        () => router.handle(action('unknown.action'), ws, reg),
        /unsupported action/,
    );
});

test('router dispatches workspace.save and workspace.restore to workflowControl', async () => {
    const dispatched: string[] = [];
    const router = createWorkspaceRouter({
        workflowControl: {
            handle: async ({ action: a }: any) => { dispatched.push(a.type); return { reply: action(`${a.type}.result`), events: [] }; },
        } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = {} as any;

    await router.handle(action('workspace.save'), ws, reg);
    await router.handle(action('workspace.restore'), ws, reg);
    assert.deepEqual(dispatched, ['workspace.save', 'workspace.restore']);
});

// ── Router: tab.* handlers ──

test('router tab.list returns tabs array', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'a', url: 'https://a.io', title: 'A' });
    ws.tabs.createTab({ tabName: 'b', url: 'https://b.io', title: 'B' });

    const result = await ws.router.handle(action('tab.list', { workspaceName: wsName }), ws, registry);
    assert.equal(result.reply.type, 'tab.list.result');
    const payload = result.reply.payload as any;
    assert.equal(payload.tabs.length, 2);
    assert.equal(payload.tabs[0].tabName, 'a');
    assert.equal(payload.tabs[1].tabName, 'b');
    assert.equal(payload.tabs[0].active, true);
});

test('router tab.create generates uuid, calls ensurePage, and sets active', async () => {
    const { registry } = createTestWorkspaceRegistry({
        getPage: async () => ({ url: () => 'about:blank', isClosed: () => false, close: async () => undefined } as any),
    });
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.create', { workspaceName: wsName, payload: { startUrl: 'https://start.io' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.create.result');
    const tabName = (result.reply.payload as any).tabName as string;
    assert.ok(tabName.length > 0);
    assert.equal(ws.tabs.getActiveTab()?.name, tabName);
});

test('router tab.close removes the tab', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'to-close' });

    const result = await ws.router.handle(
        action('tab.close', { workspaceName: wsName, payload: { tabName: 'to-close' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.close.result');
    assert.equal(ws.tabs.hasTab('to-close'), false);
});

test('router tab.setActive changes the active tab', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'first' });
    ws.tabs.createTab({ tabName: 'second' });

    const result = await ws.router.handle(
        action('tab.setActive', { workspaceName: wsName, payload: { tabName: 'second' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.setActive.result');
    assert.equal(ws.tabs.getActiveTab()?.name, 'second');
});

test('router tab.opened creates or updates metadata and sets active', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { tabName: 'ext-tab', url: 'https://ext.io', title: 'Ext', source: 'cdp', at: 1000 } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.opened.result');
    assert.equal(ws.tabs.hasTab('ext-tab'), true);
    assert.equal(ws.tabs.getTab('ext-tab')?.url, 'https://ext.io');
    assert.equal(ws.tabs.getTab('ext-tab')?.title, 'Ext');
    assert.equal(ws.tabs.getActiveTab()?.name, 'ext-tab');

    // second call updates
    const result2 = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { tabName: 'ext-tab', url: 'https://ext2.io', title: 'Ext2', source: 'cdp', at: 2000 } }),
        ws,
        registry,
    );
    assert.equal(result2.reply.type, 'tab.opened.result');
    assert.equal(ws.tabs.getTab('ext-tab')?.url, 'https://ext2.io');
    assert.equal(ws.tabs.getTab('ext-tab')?.title, 'Ext2');
});

test('router tab.report returns stale when tab unknown', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.report', { workspaceName: wsName, payload: { tabName: '', url: 'https://stale.io', source: 'cdp' } }),
        ws,
        registry,
    );
    const payload = result.reply.payload as any;
    assert.equal(payload.stale, true);
});

test('router tab.ping returns stale when tab unknown', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.ping', { workspaceName: wsName, payload: { tabName: 'ghost', source: 'cdp' } }),
        ws,
        registry,
    );
    const payload = result.reply.payload as any;
    assert.equal(payload.stale, true);
});

test('router tab.ping updates known tab', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'alive' });

    const result = await ws.router.handle(
        action('tab.ping', { workspaceName: wsName, payload: { tabName: 'alive', url: 'https://alive.io', source: 'cdp', at: 5000 } }),
        ws,
        registry,
    );
    const payload = result.reply.payload as any;
    assert.equal(payload.stale, undefined);
    assert.equal(payload.reportedUrl, 'https://alive.io');
});

test('router tab.closed with empty tabName returns early', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.closed', { workspaceName: wsName, payload: { tabName: '', source: 'cdp', at: 100 } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.closed.result');
});

test('router tab.closed removes the tab', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'kill-me' });

    const result = await ws.router.handle(
        action('tab.closed', { workspaceName: wsName, payload: { tabName: 'kill-me', source: 'cdp' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.closed.result');
    assert.equal(ws.tabs.hasTab('kill-me'), false);
});

test('router tab actions reject empty tabName where required', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const actions = ['tab.close', 'tab.setActive', 'tab.reassign'];
    for (const type of actions) {
        await assert.rejects(
            () => ws.router.handle(action(type, { workspaceName: wsName, payload: { tabName: '' } }), ws, registry),
            /tabName is required/,
        );
    }
});

// ── Router: workflow.status ──

test('router workflow.status returns identity info', async () => {
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-1' }, tabs: {} } as any;
    const reg = { getActiveWorkspace: () => ({ name: 'ws-1' }) } as any;

    const result = await router.handle(action('workflow.status'), ws, reg);
    assert.equal(result.reply.type, 'workflow.status.result');
    const payload = result.reply.payload as any;
    assert.equal(payload.exists, true);
    assert.equal(payload.active, true);
});

test('router workflow.status throws on identity mismatch', async () => {
    const router = createWorkspaceRouter({
        workflowControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        recordControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        dslControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        checkpointControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        entityRulesControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
        runnerControl: { handle: async () => ({ reply: action('noop'), events: [] }) } as any,
    });
    const ws = { name: 'ws-1', workflow: { name: 'ws-other' }, tabs: {} } as any;
    const reg = {} as any;

    await assert.rejects(
        () => router.handle(action('workflow.status'), ws, reg),
        /workspace\/workflow identity mismatch/,
    );
});

// ── Aggregate: RuntimeWorkspace domain wiring ──

test('RuntimeWorkspace exposes all domain controls', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    assert.ok(ws, 'workspace exists');
    assert.equal(typeof ws.name, 'string');
    assert.ok(ws.workflow, 'workflow domain exists');
    assert.ok(ws.tabs, 'tabs domain exists');
    assert.ok(ws.record, 'record domain exists');
    assert.ok(ws.dsl, 'dsl domain exists');
    assert.ok(ws.checkpoint, 'checkpoint domain exists');
    assert.ok(ws.entityRules, 'entityRules domain exists');
    assert.ok(ws.runner, 'runner domain exists');
    assert.ok(ws.mcp, 'mcp domain exists');
    assert.ok(ws.router, 'router exists');
    assert.equal(typeof ws.createdAt, 'number');
    assert.equal(typeof ws.updatedAt, 'number');
});

test('RuntimeWorkspace tabs domain is functional', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    ws.tabs.createTab({ tabName: 't1', url: 'https://x.com' });
    assert.equal(ws.tabs.listTabs().length, 1);
    assert.equal(ws.tabs.getActiveTab()?.name, 't1');

    ws.tabs.createTab({ tabName: 't2', url: 'https://y.com' });
    assert.equal(ws.tabs.listTabs().length, 2);
});

test('RuntimeWorkspace mcp domain has start/stop/status', async () => {
    const { registry } = createTestWorkspaceRegistry({
        portAllocator: { allocate: () => 12345, release: () => undefined },
    });
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    assert.equal(typeof ws.mcp.start, 'function');
    assert.equal(typeof ws.mcp.stop, 'function');
    assert.equal(typeof ws.mcp.status, 'function');

    const status = ws.mcp.status();
    assert.equal(status.serviceName, 'mcp');
    assert.equal(status.workspaceName, wsName);
});
