import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRecordingState } from '../../src/record/recording';
import { createWorkflowOnFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace/registry';

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
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-a`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));

    await assert.rejects(
        async () =>
            await ws.controls.record.handle({
                action: { v: 1, id: 'a1', type: 'record.start', workspaceName: ws.name } as any,
                workspace: ws as any,
                workspaceRegistry: registry as any,
            }),
        /bound page/i,
    );
});

test('record.start/get/save/load/clear/list/stop are handled in record control', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-b`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-b', page: createMockPage('https://example.com/b'), url: 'https://example.com/b' });
    ws.tabRegistry.setActiveTab('tab-b');

    const started = await ws.controls.record.handle({ action: { v: 1, id: 's1', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(started.reply.type, 'record.start.result');

    const got = await ws.controls.record.handle({ action: { v: 1, id: 's2', type: 'record.get', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(got.reply.type, 'record.get.result');

    const saved = await ws.controls.record.handle({ action: { v: 1, id: 's3', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-b' } } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(saved.reply.type, 'record.save.result');

    const loaded = await ws.controls.record.handle({ action: { v: 1, id: 's4', type: 'record.load', workspaceName: wsName, payload: { recordingName: 'rec-b' } } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(loaded.reply.type, 'record.load.result');

    const listed = await ws.controls.record.handle({ action: { v: 1, id: 's5', type: 'record.list', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(listed.reply.type, 'record.list.result');

    const cleared = await ws.controls.record.handle({ action: { v: 1, id: 's6', type: 'record.clear', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(cleared.reply.type, 'record.clear.result');

    const stopped = await ws.controls.record.handle({ action: { v: 1, id: 's7', type: 'record.stop', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(stopped.reply.type, 'record.stop.result');
});

test('record.event is ingested in record domain and not routed through actions execute', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-c`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabRegistry.createTab({ tabName: 'tab-c', page: createMockPage('https://example.com/c'), url: 'https://example.com/c' });
    ws.tabRegistry.setActiveTab('tab-c');
    await ws.controls.record.handle({ action: { v: 1, id: 'e0', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });

    const ingested = await ws.controls.record.handle({
        action: {
            v: 1,
            id: 'e1',
            type: 'record.event',
            workspaceName: wsName,
            payload: { id: 'step-1', name: 'browser.scroll', args: { direction: 'down', amount: 1 }, meta: {} },
        } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    assert.equal(ingested.reply.type, 'record.event.result');
    assert.equal((ingested.reply.payload as any).accepted, true);

    const indexSource = fs.readFileSync(path.resolve(process.cwd(), 'src/index.ts'), 'utf8');
    assert.equal(indexSource.includes('executeAction('), false);
});
