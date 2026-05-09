import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRecordingState } from '../../src/record/recording';
import { createWorkflowOnFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';

const createMockPage = (url: string) => ({
    url: () => url,
    on: () => {},
    mainFrame: () => ({ url: () => url }),
    frames: () => [],
    exposeBinding: async () => {},
    addInitScript: async () => {},
    waitForTimeout: async () => {},
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
            await ws.record.handle({
                action: { v: 1, id: 'a1', type: 'record.start', workspaceName: ws.name } as any,
                workspace: ws as any,
                workspaceRegistry: registry as any,
            }),
        /active tab not found/i,
    );
});

test('record/play state discipline and unsaved slot behavior', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-b`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-b', page: createMockPage('https://example.com/b'), url: 'https://example.com/b' });
    ws.tabs.setActiveTab('tab-b');

    const started = await ws.record.handle({ action: { v: 1, id: 's1', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(started.reply.type, 'record.start.result');

    await assert.rejects(
        async () => await ws.record.handle({ action: { v: 1, id: 's2', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any }),
        /ERR_BAD_STATE|state/i,
    );

    await assert.rejects(
        async () => await ws.record.handle({ action: { v: 1, id: 's3', type: 'play.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any }),
        /ERR_BAD_STATE|state/i,
    );

    const stopped = await ws.record.handle({ action: { v: 1, id: 's4', type: 'record.stop', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(stopped.reply.type, 'record.stop.result');

    await assert.rejects(
        async () => await ws.record.handle({ action: { v: 1, id: 's5', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-b' } } as any, workspace: ws as any, workspaceRegistry: registry as any }),
        /ERR_RECORDING_EMPTY|empty/i,
    );

    const listed = await ws.record.handle({ action: { v: 1, id: 's6', type: 'record.list', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(listed.reply.type, 'record.list.result');

    await assert.rejects(
        async () => await ws.record.handle({ action: { v: 1, id: 's7', type: 'play.start', workspaceName: wsName, payload: {} } as any, workspace: ws as any, workspaceRegistry: registry as any }),
        /ERR_RECORDING_EMPTY|empty/i,
    );

    const cleared = await ws.record.handle({ action: { v: 1, id: 's8', type: 'record.clear', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    assert.equal(cleared.reply.type, 'record.clear.result');
});

test('record.event is ingested in record domain and not routed through actions execute', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-c`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-c', page: createMockPage('https://example.com/c'), url: 'https://example.com/c' });
    ws.tabs.setActiveTab('tab-c');
    await ws.record.handle({ action: { v: 1, id: 'e0', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });

    const ingested = await ws.record.handle({
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

test('record.event flushes first tab goto before dom step and save preserves order', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-first-goto`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    ws.tabs.setActiveTab('tab-old');
    await ws.record.handle({ action: { v: 1, id: 's-first-goto', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    await ws.router.handle({ v: 1, id: 'open-first-goto', type: 'tab.opened', workspaceName: wsName, payload: { tabName: 'tab-new', url: 'about:blank', source: 'cdp' } } as any, ws as any, registry as any);
    ws.tabs.updateTab('tab-new', { url: 'https://catos.info/' });
    ws.tabs.bindPage('tab-new', createMockPage('https://catos.info/'));
    ws.tabs.setActiveTab('tab-new');

    await ws.record.handle({
        action: {
            v: 1,
            id: 'click-first-goto',
            type: 'record.event',
            workspaceName: wsName,
            payload: { tabName: 'tab-new', ts: 100, type: 'click', selector: '#home' },
        } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    const beforeSave = recordingState.recordings.get(`unsaved:${wsName}`) || [];
    assert.deepEqual(beforeSave.map((step) => step.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.click']);
    assert.equal((beforeSave[2].args as { url?: string }).url, 'https://catos.info/');

    await ws.record.handle({ action: { v: 1, id: 'stop-first-goto', type: 'record.stop', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    await ws.record.handle({
        action: { v: 1, id: 'save-first-goto', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'first-goto-order' } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    const saved = ws.workflow.get('first-goto-order', { kind: 'recording' }) as { steps?: Array<{ name: string }> } | null;
    assert.ok(saved);
    assert.deepEqual((saved.steps || []).map((step) => step.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.click']);
});

test('record.event pending fill flush stays after first tab goto', async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const wsName = `ws-${Date.now()}-fill-first-goto`;
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    ws.tabs.setActiveTab('tab-old');
    await ws.record.handle({ action: { v: 1, id: 's-fill-first-goto', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    await ws.router.handle({ v: 1, id: 'open-fill-first-goto', type: 'tab.opened', workspaceName: wsName, payload: { tabName: 'tab-new', url: 'about:blank', source: 'cdp' } } as any, ws as any, registry as any);
    ws.tabs.updateTab('tab-new', { url: 'https://catos.info/' });
    ws.tabs.bindPage('tab-new', createMockPage('https://catos.info/'));
    ws.tabs.setActiveTab('tab-new');

    await ws.record.handle({
        action: { v: 1, id: 'fill-first-goto', type: 'record.event', workspaceName: wsName, payload: { tabName: 'tab-new', ts: 100, type: 'input', selector: '#q', value: 'catos' } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    await ws.record.handle({
        action: { v: 1, id: 'click-after-fill-first-goto', type: 'record.event', workspaceName: wsName, payload: { tabName: 'tab-new', ts: 120, type: 'click', selector: '#go' } } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    const steps = recordingState.recordings.get(`unsaved:${wsName}`) || [];
    assert.deepEqual(steps.map((step) => step.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.fill', 'browser.click']);
});
