import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { handleRuntimeControlAction } from '../../src/runtime/control';
import { handleWorkspaceControlAction, setWorkspaceControlServices } from '../../src/runtime/workspace_control';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';
import { createRecordingState } from '../../src/record/recording';
import { setWorkflowControlServices } from '../../src/workflow/control';

const action = (type: string, extra: Record<string, unknown> = {}) => ({ v: 1 as const, id: 'a1', type, ...extra });

test('workspace.create and workspace.list and tab.init go through runtime control', async () => {
    const registry = createWorkspaceRegistry();
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
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });

    let createdWithStartUrl: string | undefined;
    setWorkspaceControlServices({
        pageRegistry: {
            getPage: async (_tabName: string, startUrl?: string) => {
                createdWithStartUrl = startUrl;
                return {
                    url: () => startUrl || 'about:blank',
                    isClosed: () => false,
                    close: async () => undefined,
                } as any;
            },
        },
    });

    const setActiveReply = await handleWorkspaceControlAction({
        action: action('workspace.setActive', { workspaceName: wsName }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(setActiveReply.reply.type, 'workspace.setActive.result');

    const listReply = await handleWorkspaceControlAction({
        action: action('tab.list', { workspaceName: wsName }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(listReply.reply.type, 'tab.list.result');

    const createReply = await handleWorkspaceControlAction({
        action: action('tab.create', { workspaceName: wsName, payload: { startUrl: 'https://start.url' } }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(createReply.reply.type, 'tab.create.result');
    assert.equal(createdWithStartUrl, 'https://start.url');

    const createdTabName = (createReply.reply.payload as any).tabName as string;
    const setTabReply = await handleWorkspaceControlAction({
        action: action('tab.setActive', { workspaceName: wsName, payload: { tabName: createdTabName } }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(setTabReply.reply.type, 'tab.setActive.result');

    const closeReply = await handleWorkspaceControlAction({
        action: action('tab.close', { workspaceName: wsName, payload: { tabName: createdTabName } }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(closeReply.reply.type, 'tab.close.result');
});

test('tab.reassign uses action.workspaceName and ignores payload.workspaceName', async () => {
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    const reply = await handleWorkspaceControlAction({
        action: action('tab.reassign', {
            workspaceName: wsName,
            payload: { workspaceName: 'ws-payload', tabName: 'tab-9', source: 'test' },
        }),
        workspace: ws,
        workspaceRegistry: registry,
    });

    assert.equal(reply.reply.type, 'tab.reassign.result');
    assert.equal((reply.reply.payload as any).workspaceName, wsName);
    assert.equal(ws.tabRegistry.hasTab('tab-9'), true);
});

test('workspace.save and workspace.restore are routed from workspace control to workflow control', async () => {
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });
    ws.tabRegistry.setActiveTab('tab-1');
    setWorkflowControlServices({ recordingState: createRecordingState() });

    const saveReply = await handleWorkspaceControlAction({
        action: action('workspace.save', { workspaceName: wsName }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(saveReply.reply.type, 'workspace.save.result');

    const restoreReply = await handleWorkspaceControlAction({
        action: action('workspace.restore', { workspaceName: wsName }),
        workspace: ws,
        workspaceRegistry: registry,
    });
    assert.equal(restoreReply.reply.type, 'workspace.restore.result');
});
