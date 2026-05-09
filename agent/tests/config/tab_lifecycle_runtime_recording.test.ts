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

test('closing active new tab records close_tab then switch_tab back to old tab', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.closed', workspaceName, { tabName: 'tab-new', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.deepEqual(steps.map((s) => s.name), ['browser.create_tab', 'browser.switch_tab', 'browser.close_tab', 'browser.switch_tab']);
});

test('repeated active events do not duplicate switch_tab', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.opened', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-new', url: 'https://new', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.filter((s) => s.name === 'browser.switch_tab').length, 1);
});

test('tab.activated does not record switch_tab when active tab is unchanged', async () => {
    const { recordingState, registry, ws, workspaceName } = await setup();
    await ws.router.handle(action('tab.activated', workspaceName, { tabName: 'tab-old', url: 'https://old', source: 'cdp' }), ws, registry);
    const steps = recordingState.recordings.get(getWorkspaceUnsavedToken(recordingState, workspaceName)) || [];
    assert.equal(steps.some((s) => s.name === 'browser.switch_tab'), false);
});
