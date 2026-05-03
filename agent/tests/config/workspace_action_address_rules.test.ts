import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleRuntimeControlAction } from '../../src/runtime/control_plane';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: 'a1', type, ...extra });

test('workspace.create and workspace.list and tab.init go through runtime control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;

    const createReply = await handleRuntimeControlAction({
        action: action('workspace.create', { payload: { workspaceName: wsName } }),
        workspaceRegistry: registry,
    });
    assert.equal(createReply.reply.type, 'workspace.create.result');

    const listReply = await handleRuntimeControlAction({
        action: action('workspace.list'),
        workspaceRegistry: registry,
    });
    assert.equal(listReply.reply.type, 'workspace.list.result');
    assert.equal(Array.isArray((listReply.reply.payload as any).workspaces), true);

    const initReply = await handleRuntimeControlAction({
        action: action('tab.init'),
        workspaceRegistry: registry,
    });
    assert.equal(initReply.reply.type, 'tab.init.result');
    assert.equal(typeof (initReply.reply.payload as any).tabName, 'string');
});

test('workspace.setActive and tab actions go through workspace control', async () => {
    let createdWithStartUrl: string | undefined;
    const { registry } = createTestWorkspaceRegistry({
        getPage: async (_tabName: string, startUrl?: string) => {
            createdWithStartUrl = startUrl;
            return {
                url: () => startUrl || 'about:blank',
                isClosed: () => false,
                close: async () => undefined,
            } as any;
        },
    });
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });

    const setActiveReply = await ws.router.handle(
        action('workspace.setActive', { workspaceName: wsName }),
        ws,
        registry,
    );
    assert.equal(setActiveReply.reply.type, 'workspace.setActive.result');

    const listReply = await ws.router.handle(action('tab.list', { workspaceName: wsName }), ws, registry);
    assert.equal(listReply.reply.type, 'tab.list.result');

    const createReply = await ws.router.handle(
        action('tab.create', { workspaceName: wsName, payload: { startUrl: 'https://start.url' } }),
        ws,
        registry,
    );
    assert.equal(createReply.reply.type, 'tab.create.result');
    assert.equal(createdWithStartUrl, 'https://start.url');

    const createdTabName = (createReply.reply.payload as any).tabName as string;
    const setTabReply = await ws.router.handle(
        action('tab.setActive', { workspaceName: wsName, payload: { tabName: createdTabName } }),
        ws,
        registry,
    );
    assert.equal(setTabReply.reply.type, 'tab.setActive.result');

    const closeReply = await ws.router.handle(
        action('tab.close', { workspaceName: wsName, payload: { tabName: createdTabName } }),
        ws,
        registry,
    );
    assert.equal(closeReply.reply.type, 'tab.close.result');
});

test('tab.reassign uses action.workspaceName and ignores payload.workspaceName', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const reply = await ws.router.handle(
        action('tab.reassign', {
            workspaceName: wsName,
            payload: { workspaceName: 'ws-payload', tabName: 'tab-9', source: 'test' },
        }),
        ws,
        registry,
    );

    assert.equal(reply.reply.type, 'tab.reassign.result');
    assert.equal((reply.reply.payload as any).workspaceName, wsName);
    assert.equal(ws.tabs.hasTab('tab-9'), true);
});

test('workspace.save and workspace.restore are routed from workspace control to workflow control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });
    ws.tabs.setActiveTab('tab-1');
    const saveReply = await ws.router.handle(action('workspace.save', { workspaceName: wsName }), ws, registry);
    assert.equal(saveReply.reply.type, 'workspace.save.result');

    const restoreReply = await ws.router.handle(action('workspace.restore', { workspaceName: wsName }), ws, registry);
    assert.equal(restoreReply.reply.type, 'workspace.restore.result');
});
