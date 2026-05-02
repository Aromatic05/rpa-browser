import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createWorkflowOnFs } from '../../src/workflow';
import { createRecordingState } from '../../src/record/recording';
import { setWorkflowControlServices, handleWorkflowControlAction } from '../../src/workflow/control';

test('workspace.save is handled by workflow control', async () => {
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-1', url: 'https://example.com', title: 'Example' });
    ws.tabRegistry.setActiveTab('tab-1');

    const recordingState = createRecordingState();
    setWorkflowControlServices({ recordingState });

    const result = await handleWorkflowControlAction({
        action: { v: 1, id: 's1', type: 'workspace.save', workspaceName: wsName },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);

    assert.equal(result.reply.type, 'workspace.save.result');
    assert.equal((result.reply.payload as any).saved, true);
});

test('workspace.restore is handled by workflow control', async () => {
    const registry = createWorkspaceRegistry();
    const wsName = `ws-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-a', url: 'https://example.com/a', title: 'A' });
    ws.tabRegistry.setActiveTab('tab-a');

    const recordingState = createRecordingState();
    setWorkflowControlServices({ recordingState });

    await handleWorkflowControlAction({
        action: { v: 1, id: 's2', type: 'workspace.save', workspaceName: wsName },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);

    const result = await handleWorkflowControlAction({
        action: { v: 1, id: 's3', type: 'workspace.restore', workspaceName: wsName },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);

    assert.equal(result.reply.type, 'workspace.restore.result');
    assert.equal((result.reply.payload as any).restored, true);
    assert.equal(typeof (result.reply.payload as any).workspaceName, 'string');
});
