import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkspaceHarness } from '../../helpers/workspace_harness';
import { createWorkflowOnFs } from '../../../src/workflow';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: crypto.randomUUID(), type, ...extra });

// ── Router: tab.* handlers via full workspace ──

test('router tab.list returns tabs array', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'a' });
    ws.tabs.createTab({ tabName: 'b' });

    const result = await ws.router.handle(action('tab.list', { workspaceName: wsName }), ws, registry);
    assert.equal(result.reply.type, 'tab.list.result');
    const payload = result.reply.payload as any;
    assert.equal(payload.tabs.length, 2);
    assert.equal(payload.tabs[0].tabName, 'a');
    assert.equal(payload.tabs[1].tabName, 'b');
    assert.equal(payload.tabs[0].active, true);
});

test('router tab.close acknowledges but does not remove tab', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'to-close' });

    const result = await ws.router.handle(
        action('tab.close', { workspaceName: wsName, payload: { tabName: 'to-close' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.close.result');
    // tab.close does NOT delete tab identity — tab.closed is the sole commit point
    assert.equal(ws.tabs.hasTab('to-close'), true);
    // tab.close forwards the action as an event for the extension to execute
    assert.ok(result.events.length > 0);
    assert.equal(result.events[0].type, 'tab.close');
});

test('router tab.setActive changes the active tab', async () => {
    const { registry } = createWorkspaceHarness();
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

test('router tab.opened allocates UUID without committing workspace tab', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { chromeTabNo: 42, windowId: 7, urlHint: 'https://ext.io', titleHint: 'Ext', source: 'extension.sw', openedAt: 1000 } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.bind');
    const tabName = (result.reply.payload as any).tabName as string;
    // Agent generates tabName (UUID), not from payload
    assert.ok(typeof tabName === 'string' && tabName.length > 0);
    assert.notEqual(tabName, 'ext-tab');
    // tab.opened does NOT create workspace tab — tab.bound is where commitment happens
    assert.equal(ws.tabs.hasTab(tabName), false);
    assert.equal(ws.tabs.getActiveTab(), null);

    // Second tab.opened allocates a different UUID each time
    const result2 = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { chromeTabNo: 43, windowId: 7, urlHint: 'https://ext2.io', titleHint: 'Ext2', source: 'extension.sw', openedAt: 2000 } }),
        ws,
        registry,
    );
    assert.equal(result2.reply.type, 'tab.bind');
    const tabName2 = (result2.reply.payload as any).tabName as string;
    assert.notEqual(tabName2, tabName);
    assert.equal(ws.tabs.hasTab(tabName2), false);
});

test('router tab.report returns stale when tab unknown', async () => {
    const { registry } = createWorkspaceHarness();
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
    const { registry } = createWorkspaceHarness();
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
    const { registry } = createWorkspaceHarness();
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

test('router tab.reassigned assigns tab to workspace via existing tab', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 're-tab' });

    const result = await ws.router.handle(
        action('tab.reassigned', { workspaceName: wsName, payload: { tabName: 're-tab', source: 'test' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.reassigned.result');
    assert.equal(ws.tabs.hasTab('re-tab'), true);
});

test('router tab actions reject empty tabName where required', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const actions = ['tab.close', 'tab.setActive', 'tab.reassigned'];
    for (const type of actions) {
        await assert.rejects(
            () => ws.router.handle(action(type, { workspaceName: wsName, payload: { tabName: '' } }), ws, registry),
            /tabName is required/,
        );
    }
});

test('tab.open allocates UUID without committing workspace tab', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.open', { workspaceName: wsName, payload: {} }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.open.result');
    const createId = (result.reply.payload as any).createId as string;
    assert.ok(typeof createId === 'string' && createId.length > 0);
    // tab.open does NOT create workspace tab — tab.bound is where commitment happens
    assert.equal(ws.tabs.hasTab(createId), false);
    assert.equal(ws.tabs.getActiveTab(), null);
});

test('tab.reassigned errors on unknown tab', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(
            action('tab.reassigned', { workspaceName: wsName, payload: { tabName: 'ghost', source: 'test' } }),
            ws,
            registry,
        ),
        /tab not found/,
    );
});

// ── Router: deleted actions are rejected ──

test('router does not handle workspace.save', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workspace.save', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle workspace.restore', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workspace.restore', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle workflow.status', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('workflow.status', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

test('router does not handle tab.init', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(action('tab.init', { workspaceName: wsName }), ws, registry),
        /unsupported/,
    );
});

// ── RuntimeWorkspace aggregate structure ──

test('RuntimeWorkspace directly holds tabs', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.tabs);
    assert.equal(typeof ws.tabs.listTabs, 'function');
});

test('RuntimeWorkspace directly holds record', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.record);
});

test('RuntimeWorkspace directly holds dsl', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.dsl);
});

test('RuntimeWorkspace directly holds checkpoint', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.checkpoint);
});

test('RuntimeWorkspace directly holds entityRules', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.entityRules);
});

test('RuntimeWorkspace directly holds runner', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.runner);
});

test('RuntimeWorkspace directly holds mcp', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.mcp);
    assert.equal(typeof ws.mcp.start, 'function');
    assert.equal(typeof ws.mcp.stop, 'function');
    assert.equal(typeof ws.mcp.status, 'function');
});

test('RuntimeWorkspace directly holds router', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.ok(ws.router);
    assert.equal(typeof ws.router.handle, 'function');
});

test('RuntimeWorkspace does not have tabRegistry', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('tabRegistry' in ws, false);
});

test('RuntimeWorkspace does not have getPage', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('getPage' in ws, false);
});

test('RuntimeWorkspace does not have controls', () => {
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    assert.equal('controls' in ws, false);
});

test('RuntimeWorkspace does not have serviceLifecycle', () => {
    const { registry } = createWorkspaceHarness();
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
    const { registry } = createWorkspaceHarness({
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
    const { registry } = createWorkspaceHarness();
    const wfName = `wf-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wfName, createWorkflowOnFs(wfName));
    ws.tabs.createTab({ tabName: 'close-me' });
    assert.equal(ws.tabs.hasTab('close-me'), true);

    await ws.tabs.closeTab('close-me');
    assert.equal(ws.tabs.hasTab('close-me'), false);
});

test('tab.create goes through TabsControl via router', async () => {
    const { registry } = createWorkspaceHarness({
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
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.opened', { workspaceName: wsName, payload: { chromeTabNo: 99, windowId: 7, urlHint: 'https://cdp.io', source: 'cdp', openedAt: Date.now() } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.bind');
    // Agent generates tabName — UUID allocation only, no workspace tab creation
    const tabName = (result.reply.payload as any).tabName as string;
    assert.ok(typeof tabName === 'string' && tabName.length > 0);
    assert.equal(ws.tabs.hasTab(tabName), false);
});

test('Agent TabsControl rejects inbound tab.bind', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    await assert.rejects(
        () => ws.router.handle(
            action('tab.bind', { workspaceName: wsName, payload: { tabName: 'someone-else', chromeTabNo: 1, windowId: 1 } }),
            ws,
            registry,
        ),
        /unsupported tab action/,
    );
});

test('tab.reassigned goes through TabsControl via router', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'reassign-me' });

    const result = await ws.router.handle(
        action('tab.reassigned', { workspaceName: wsName, payload: { tabName: 'reassign-me', source: 'test' } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.reassigned.result');
    assert.equal((result.reply.payload as any).workspaceName, wsName);
    assert.equal(ws.tabs.hasTab('reassign-me'), true);
});

test('tab.bound creates workspace tab and sets active', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const result = await ws.router.handle(
        action('tab.bound', { workspaceName: wsName, payload: { tabName: 'bound-tab', chromeTabNo: 7, windowId: 1, url: 'https://bound.io', boundAt: Date.now() } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.bound.result');
    assert.equal((result.reply.payload as any).workspaceName, wsName);
    assert.equal((result.reply.payload as any).tabName, 'bound-tab');
    // tab.bound commits the workspace tab
    assert.equal(ws.tabs.hasTab('bound-tab'), true);
    assert.equal(ws.tabs.getActiveTab()?.name, 'bound-tab');
});

test('tab.bound updates existing tab without recreating', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'existing', at: 1000 });

    const result = await ws.router.handle(
        action('tab.bound', { workspaceName: wsName, payload: { tabName: 'existing', chromeTabNo: 8, windowId: 1, url: 'https://existing.io', boundAt: 2000 } }),
        ws,
        registry,
    );
    assert.equal(result.reply.type, 'tab.bound.result');
    assert.equal(ws.tabs.hasTab('existing'), true);
    assert.equal(ws.tabs.getActiveTab()?.name, 'existing');
});

test('tab.bound rejects empty tabName', async () => {
    const { registry } = createWorkspaceHarness();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        () => ws.router.handle(
            action('tab.bound', { workspaceName: wsName, payload: { tabName: '' } }),
            ws,
            registry,
        ),
        /tabName is required/,
    );
});
