import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRecordingState, getWorkspaceUnsavedToken } from '../../src/record/recording';
import { createWorkflowOnFs } from '../../src/workflow';
import { createTestWorkspaceRegistry } from '../helpers/workspace_registry';

const createMockPage = (url: string) =>
    ({
        url: () => url,
        on: () => undefined,
        mainFrame: () => ({ url: () => url }),
        frames: () => [],
        context: () => ({}) as any,
        exposeBinding: async () => undefined,
        addInitScript: async () => undefined,
        waitForTimeout: async () => undefined,
        evaluate: async () => undefined,
        goto: async () => undefined,
        isClosed: () => false,
        close: async () => undefined,
    }) as any;

const action = (type: string, workspaceName: string, payload: Record<string, unknown>) =>
    ({ v: 1, id: crypto.randomUUID(), type, workspaceName, payload }) as any;

const setup = async () => {
    const recordingState = createRecordingState();
    const { registry } = createTestWorkspaceRegistry({ recordingState });
    const workspaceName = `ws-tab-life-${crypto.randomUUID()}`;
    const ws = registry.createWorkspace(workspaceName, createWorkflowOnFs(workspaceName));
    ws.tabs.createTab({ tabName: 'tab-old', page: createMockPage('https://old'), url: 'https://old' });
    ws.tabs.setActiveTab('tab-old');
    await ws.record.handle({ action: { v: 1, id: 'start', type: 'record.start', workspaceName } as any, workspace: ws as any, workspaceRegistry: registry as any });
    return { recordingState, registry, ws, workspaceName };
};

test('closing active new tab records close_tab; switch_tab comes from later tab.activated event', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.closed', workspaceName, { tabName: 'tab-new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-old', url: 'https://old', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.deepEqual(steps.map((s) => s.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.close_tab', 'browser.switch_tab']);
});

test('repeated active events do not duplicate switch_tab', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.filter((s) => s.name === 'browser.switch_tab').length, 1);
});

test('tab.activated dedupes unchanged active tab when repeated', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-old', url: 'https://old', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-old', url: 'https://old', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.filter((s) => s.name === 'browser.switch_tab').length, 1);
});

test('click create switch close switch order remains stable', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.record.handle({
        action: {
            v: 1,
            id: 'evt-click',
            type: 'record.event',
            workspaceName,
            payload: { id: 'click-1', name: 'browser.click', args: { selector: '#open' }, meta: { source: 'record', ts: Date.now() } },
        } as any,
        workspace: ws as any,
        workspaceRegistry: registry as any,
    });
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.closed', workspaceName, { tabName: 'tab-new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-old', url: 'https://old', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.deepEqual(steps.map((s) => s.name), ['browser.click', 'browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.close_tab', 'browser.switch_tab']);
    const created = steps.find((s) => s.name === 'browser.create_tab')!;
    const closed = steps.find((s) => s.name === 'browser.close_tab')!;
    assert.equal(typeof created.meta?.tabName, 'string');
    assert.equal(typeof created.meta?.tabRef, 'string');
    assert.equal(typeof closed.meta?.tabName, 'string');
    assert.equal(typeof closed.meta?.tabRef, 'string');
    const switchedAfterCreate = steps[2];
    const switchedAfterClose = steps[5];
    assert.equal(switchedAfterCreate.name, 'browser.switch_tab');
    assert.equal(switchedAfterClose.name, 'browser.switch_tab');
});

test('tab.closed alone does not generate switch_tab', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.closed', workspaceName, { tabName: 'tab-new', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.deepEqual(steps.map((s) => s.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto', 'browser.close_tab']);
});
