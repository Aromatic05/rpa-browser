import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkflowOnFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';

test('workspace.save is handled by workflow control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });
    ws.tabs.setActiveTab('tab-1');

    const result = await ws.router.handle(
        { v: 1, id: 's1', type: 'workspace.save', workspaceName: wsName } as any,
        ws as any,
        registry as any,
    );

    assert.equal(result.reply.type, 'workspace.save.result');
    assert.equal((result.reply.payload as any).saved, true);
});

test('workspace.restore is handled by workflow control', async () => {
    const { registry } = createTestWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-a', url: 'https://example.com/a', title: 'A' });
    ws.tabs.setActiveTab('tab-a');

    await ws.router.handle(
        { v: 1, id: 's2', type: 'workspace.save', workspaceName: wsName } as any,
        ws as any,
        registry as any,
    );

    const result = await ws.router.handle(
        { v: 1, id: 's3', type: 'workspace.restore', workspaceName: wsName } as any,
        ws as any,
        registry as any,
    );

    assert.equal(result.reply.type, 'workspace.restore.result');
    assert.equal((result.reply.payload as any).restored, true);
    assert.equal(typeof (result.reply.payload as any).workspaceName, 'string');
});
