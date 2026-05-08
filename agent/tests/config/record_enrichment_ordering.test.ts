import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState, enableWorkspaceRecording, resetWorkspaceUnsavedRecording, setRecordedStepEnricherForTest } from '../../src/record/recording';
import { createWorkflowOnFs, deleteWorkflowFromFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';
import { appendWorkspaceRecordingEvent } from '../../src/record/recording';

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

const uniqueName = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;

test('record.save waits pending enrichment and saves resolved enhancement', async () => {
    const wsName = uniqueName('record-save-wait');
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com'), url: 'https://example.com' });
    ws.tabs.setActiveTab('tab-1');
    resetWorkspaceUnsavedRecording(recordingState, wsName, { activeTabRef: 'tab-1', entryTabRef: 'tab-1', initialTabs: [] });
    enableWorkspaceRecording(recordingState, wsName);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setRecordedStepEnricherForTest(async ({ event }) => {
        await gate;
        return {
            version: 1,
            eventType: event.type,
            resolveHint: { raw: { selector: '#save-btn' } },
            resolvePolicy: { requireVisible: true },
        };
    });
    try {
        await appendWorkspaceRecordingEvent(recordingState, wsName, 'tab-1', {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'click',
            selector: '#save-btn',
        }, 1200);
        const savePromise = ws.record.handle({
            action: { v: 1, id: 's1', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-a', includeStepResolve: true } } as any,
            workspace: ws as any,
            workspaceRegistry: registry as any,
        });
        const beforeRelease = await Promise.race([
            savePromise.then(() => 'saved'),
            new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 30)),
        ]);
        assert.equal(beforeRelease, 'pending');
        release();
        const saved = await savePromise;
        assert.equal(saved.reply.type, 'record.save.result');
        const loaded = ws.workflow.get('rec-a', { kind: 'recording' });
        assert.equal(loaded?.kind, 'recording');
        const stepId = loaded?.steps[0]?.id || '';
        assert.equal(Boolean(stepId), true);
        assert.equal(Boolean(loaded?.stepResolves?.[stepId]), true);
    } finally {
        setRecordedStepEnricherForTest(null);
        deleteWorkflowFromFs(wsName);
    }
});

test('record.get returns immediately without waiting pending enrichment', async () => {
    const wsName = uniqueName('record-get-nowait');
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    resetWorkspaceUnsavedRecording(recordingState, wsName, { activeTabRef: 'tab-1', entryTabRef: 'tab-1', initialTabs: [] });
    enableWorkspaceRecording(recordingState, wsName);
    const gate = new Promise<void>(() => {});
    setRecordedStepEnricherForTest(async ({ event }) => {
        await gate;
        return { version: 1, eventType: event.type };
    });
    try {
        await appendWorkspaceRecordingEvent(recordingState, wsName, 'tab-1', {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'click',
            selector: '#a',
        }, 1200);
        const startedAt = Date.now();
        const result = await ws.record.handle({
            action: { v: 1, id: 'g1', type: 'record.get', workspaceName: wsName } as any,
            workspace: ws as any,
            workspaceRegistry: registry as any,
        });
        assert.equal(result.reply.type, 'record.get.result');
        assert.equal((result.reply.payload as any).unsaved.stepCount, 1);
        assert.equal(Date.now() - startedAt < 200, true);
    } finally {
        setRecordedStepEnricherForTest(null);
        deleteWorkflowFromFs(wsName);
    }
});

test('record.stop does not wait pending enrichment', async () => {
    const wsName = uniqueName('record-stop-nowait');
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com'), url: 'https://example.com' });
    ws.tabs.setActiveTab('tab-1');
    await ws.record.handle({ action: { v: 1, id: 'r1', type: 'record.start', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    const gate = new Promise<void>(() => {});
    setRecordedStepEnricherForTest(async ({ event }) => {
        await gate;
        return { version: 1, eventType: event.type };
    });
    try {
        await appendWorkspaceRecordingEvent(recordingState, wsName, 'tab-1', {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'click',
            selector: '#a',
        }, 1200);
        const stopStarted = Date.now();
        const stopped = await ws.record.handle({ action: { v: 1, id: 'r2', type: 'record.stop', workspaceName: wsName } as any, workspace: ws as any, workspaceRegistry: registry as any });
        assert.equal(stopped.reply.type, 'record.stop.result');
        assert.equal(Date.now() - stopStarted < 200, true);
    } finally {
        setRecordedStepEnricherForTest(null);
        deleteWorkflowFromFs(wsName);
    }
});

test('play.start for unsaved does not wait pending enrichment', async () => {
    const wsName = uniqueName('play-unsaved-nowait');
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com'), url: 'https://example.com' });
    ws.tabs.setActiveTab('tab-1');
    resetWorkspaceUnsavedRecording(recordingState, wsName, { activeTabRef: 'tab-1', entryTabRef: 'tab-1', entryUrl: 'https://example.com', initialTabs: [] });
    enableWorkspaceRecording(recordingState, wsName);
    recordingState.recordings.set(`unsaved:${wsName}`, [{
        id: 's1',
        name: 'browser.goto',
        args: { url: 'https://example.com' },
        meta: { source: 'record', ts: Date.now(), tabName: 'tab-1' },
    }] as any);
    const gate = new Promise<void>(() => {});
    setRecordedStepEnricherForTest(async ({ event }) => {
        await gate;
        return { version: 1, eventType: event.type };
    });
    try {
        await appendWorkspaceRecordingEvent(recordingState, wsName, 'tab-1', {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'click',
            selector: '#a',
        }, 1200);
        const startedAt = Date.now();
        const started = await ws.record.handle({ action: { v: 1, id: 'p1', type: 'play.start', workspaceName: wsName, payload: {} } as any, workspace: ws as any, workspaceRegistry: registry as any });
        assert.equal(started.reply.type, 'play.started');
        assert.equal(Date.now() - startedAt < 200, true);
    } finally {
        setRecordedStepEnricherForTest(null);
        deleteWorkflowFromFs(wsName);
    }
});

test('record.save includeStepResolve does not fallback to step.resolve when enrichment is missing', async () => {
    const wsName = uniqueName('record-save-no-fallback');
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const ws = registry.createWorkspace(wsName, createWorkflowOnFs(wsName));
    ws.tabs.createTab({ tabName: 'tab-1', page: createMockPage('https://example.com'), url: 'https://example.com' });
    ws.tabs.setActiveTab('tab-1');
    resetWorkspaceUnsavedRecording(recordingState, wsName, { activeTabRef: 'tab-1', entryTabRef: 'tab-1', initialTabs: [] });
    enableWorkspaceRecording(recordingState, wsName);
    setRecordedStepEnricherForTest(async ({ event }) => ({ version: 1, eventType: event.type }));
    try {
        await appendWorkspaceRecordingEvent(recordingState, wsName, 'tab-1', {
            tabName: 'tab-1',
            ts: Date.now(),
            type: 'click',
            selector: '#save-btn',
            a11yHint: { role: 'button', name: 'Save' },
        }, 1200);
        const saved = await ws.record.handle({
            action: { v: 1, id: 's1', type: 'record.save', workspaceName: wsName, payload: { recordingName: 'rec-no-fallback', includeStepResolve: true } } as any,
            workspace: ws as any,
            workspaceRegistry: registry as any,
        });
        assert.equal(saved.reply.type, 'record.save.result');
        const loaded = ws.workflow.get('rec-no-fallback', { kind: 'recording' });
        assert.equal(loaded?.kind, 'recording');
        const stepId = loaded?.steps[0]?.id || '';
        assert.equal(Boolean(stepId), true);
        assert.equal(Boolean(loaded?.stepResolves?.[stepId]), false);
    } finally {
        setRecordedStepEnricherForTest(null);
        deleteWorkflowFromFs(wsName);
    }
});
