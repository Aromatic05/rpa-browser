import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: crypto.randomUUID(), type, ...extra });

// ── Router: tab.* handlers via full workspace ──

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

test('router tab.create generates tabName, calls ensurePage, and sets active', async () => {
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

test('router tab.opened creates metadata tab and sets active', async () => {
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
    assert.equal(ws.tabs.getActiveTab()?.name, 'ext-tab');

    const result2 = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { tabName: 'ext-tab', url: 'https://ext2.io', title: 'Ext2', source: 'cdp', at: 2000 } }),
        ws,
        registry,
    );
    assert.equal(result2.reply.type, 'tab.opened.result');
    assert.equal(ws.tabs.getTab('ext-tab')?.url, 'https://ext2.io');
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

test('router tab.reassign assigns tab to workspace', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.reassign', { workspaceName: wsName, payload: { tabName: 're-tab', source: 'test' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.reassign.result');
    assert.equal(ws.tabs.hasTab('re-tab'), true);
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

// ── Router: deleted actions are rejected ──

test('router does not handle workspace.save', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workspace.save', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle workspace.restore', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workspace.restore', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle workflow.status', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workflow.status', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle tab.init', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('tab.init', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

// ── RuntimeWorkspace aggregate structure ──

test('RuntimeWorkspace directly holds tabs', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.tabs);
    assert.equal(typeof ws.tabs.listTabs, 'function');
});

test('RuntimeWorkspace directly holds record', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.record);
});

test('RuntimeWorkspace directly holds dsl', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.dsl);
});

test('RuntimeWorkspace directly holds checkpoint', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.checkpoint);
});

test('RuntimeWorkspace directly holds entityRules', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.entityRules);
});

test('RuntimeWorkspace directly holds runner', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.runner);
});

test('RuntimeWorkspace directly holds mcp', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.mcp);
    assert.equal(typeof ws.mcp.start, 'function');
    assert.equal(typeof ws.mcp.stop, 'function');
    assert.equal(typeof ws.mcp.status, 'function');
});

test('RuntimeWorkspace directly holds router', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.router);
    assert.equal(typeof ws.router.handle, 'function');
});

test('RuntimeWorkspace does not have tabRegistry', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('tabRegistry' in ws, false);
});

test('RuntimeWorkspace does not have getPage', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('getPage' in ws, false);
});

test('RuntimeWorkspace does not have controls', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('controls' in ws, false);
});

test('RuntimeWorkspace does not have serviceLifecycle', () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('serviceLifecycle' in ws, false);
});

// ── workspace.ts construction discipline ──

test('workspace.ts has no null as unknown', () => {
    const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/runtime/workspace/workspace.ts'),
        'utf-8',
    );
    assert.equal(src.includes('null as unknown'), false);
});

test('workspace.ts has no mcp router backfill', () => {
    const src = fs.readFileSync(
        path.resolve(process.cwd(), 'src/runtime/workspace/workspace.ts'),
        'utf-8',
    );
    assert.equal(src.includes('workspace.mcp ='), false);
    assert.equal(src.includes('workspace.router ='), false);
});

// ── WorkspaceTabs lifecycle via full workspace ──

test('WorkspaceTabs.ensurePage creates page and binds tab', async () => {
    let pageCreated = false;
    const { registry } = createTestWorkspaceRegistry({
        getPage: async () => {
            pageCreated = true;
            return { url: () => 'about:blank', isClosed: () => false } as any;
        },
    });
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));

    const page = await ws.tabs.ensurePage('new-tab');
    assert.equal(pageCreated, true);
    assert.ok(ws.tabs.hasTab('new-tab'));
});

test('WorkspaceTabs.closeTab removes tab', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    ws.tabs.createTab({ tabName: 'close-me', url: 'https://x.com' });
    assert.equal(ws.tabs.hasTab('close-me'), true);

    await ws.tabs.closeTab('close-me');
    assert.equal(ws.tabs.hasTab('close-me'), false);
});

test('tab.create goes through TabsControl via router', async () => {
    const { registry } = createTestWorkspaceRegistry({
        getPage: async () => ({ url: () => 'about:blank', isClosed: () => false } as any),
    });
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.create', { workspaceName: wsName, payload: { startUrl: 'https://new.io' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.create.result');
    assert.ok(typeof (result.reply.payload as any).tabName === 'string');
});

test('tab.opened goes through TabsControl via router', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { tabName: 'cdp-tab', url: 'https://cdp.io', source: 'cdp', at: Date.now() } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.opened.result');
    assert.equal(ws.tabs.hasTab('cdp-tab'), true);
});

test('tab.reassign goes through TabsControl via router', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.reassign', { workspaceName: wsName, payload: { tabName: 'reassign-me', source: 'test' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.reassign.result');
    assert.equal((result.reply.payload as any).workspaceName, wsName);
    assert.equal(ws.tabs.hasTab('reassign-me'), true);
});
