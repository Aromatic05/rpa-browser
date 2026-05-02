import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRecordingState } from '../../src/record/recording';
import { handleRecordControlAction, setRecordControlServices } from '../../src/record/control';
import { createWorkflowOnFs } from '../../src/workflow';

const createMockPage = (url: string) => ({
    url: () => url,
    on: () => {},
    mainFrame: () => ({ url: () => url }),
    frames: () => [],
    exposeBinding: async () => {},
    addInitScript: async () => {},
    evaluate: async () => {},
    goto: async () => {},
    isClosed: () => false,
    close: async () => {},
}) as any;

test('record.start fails clearly when workspace has no bound page', async () => {
    const registry = createWorkspaceRegistry();
    const recordingState = createRecordingState();
    const wsName = `ws-${Date.now()}-a`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    setRecordControlServices({
        recordingState,
        replayOptions: { clickDelayMs: 1, stepDelayMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
    });

    await assert.rejects(
        async () =>
            await handleRecordControlAction({
                action: { v: 1, id: 'a1', type: 'record.start', workspaceName: ws.name },
                workspace: ws,
                workspaceRegistry: registry,
            } as any),
        /bound page/i,
    );
});

test('record.start/get/save/load/clear/list/stop are handled in record control', async () => {
    const registry = createWorkspaceRegistry();
    const recordingState = createRecordingState();
    const wsName = `ws-${Date.now()}-b`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-b', page: createMockPage('https://example.com/b'), url: 'https://example.com/b' });
    ws.tabRegistry.setActiveTab('tab-b');

    setRecordControlServices({
        recordingState,
        replayOptions: { clickDelayMs: 1, stepDelayMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
    });

    const started = await handleRecordControlAction({ action: { v: 1, id: 's1', type: 'record.start', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(started.reply.type, 'record.start.result');

    const got = await handleRecordControlAction({ action: { v: 1, id: 's2', type: 'record.get', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(got.reply.type, 'record.get.result');

    const saved = await handleRecordControlAction({ action: { v: 1, id: 's3', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-b' } }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(saved.reply.type, 'record.save.result');

    const loaded = await handleRecordControlAction({ action: { v: 1, id: 's4', type: 'record.load', workspaceName: wsName, payload: { recordingName: 'rec-b' } }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(loaded.reply.type, 'record.load.result');

    const listed = await handleRecordControlAction({ action: { v: 1, id: 's5', type: 'record.list', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(listed.reply.type, 'record.list.result');

    const cleared = await handleRecordControlAction({ action: { v: 1, id: 's6', type: 'record.clear', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(cleared.reply.type, 'record.clear.result');

    const stopped = await handleRecordControlAction({ action: { v: 1, id: 's7', type: 'record.stop', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);
    assert.equal(stopped.reply.type, 'record.stop.result');
});

test('record.event is ingested in record domain and not routed through actions execute', async () => {
    const registry = createWorkspaceRegistry();
    const recordingState = createRecordingState();
    const wsName = `ws-${Date.now()}-c`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-c', page: createMockPage('https://example.com/c'), url: 'https://example.com/c' });
    ws.tabRegistry.setActiveTab('tab-c');
    setRecordControlServices({
        recordingState,
        replayOptions: { clickDelayMs: 1, stepDelayMs: 1, scroll: { minDelta: 1, maxDelta: 2, minSteps: 1, maxSteps: 2 } },
        navDedupeWindowMs: 1200,
    });
    await handleRecordControlAction({ action: { v: 1, id: 'e0', type: 'record.start', workspaceName: wsName }, workspace: ws, workspaceRegistry: registry } as any);

    const ingested = await handleRecordControlAction({
        action: {
            v: 1,
            id: 'e1',
            type: 'record.event',
            workspaceName: wsName,
            payload: { id: 'step-1', name: 'browser.scroll', args: { direction: 'down', amount: 1 }, meta: {} },
        },
        workspace: ws,
        workspaceRegistry: registry,
    } as any);
    assert.equal(ingested.reply.type, 'record.event.result');
    assert.equal((ingested.reply.payload as any).accepted, true);

    const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    assert.equal(indexSource.includes('executeAction('), false);
});
