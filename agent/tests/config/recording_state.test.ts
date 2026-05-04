import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearRecording,
    cleanupRecording,
    createRecordingState,
    getWorkspaceSnapshot,
    getRecording,
    getRecordingBundle,
    listWorkspaceRecordings,
    recordStep,
    recordEvent,
    saveWorkspaceSnapshot,
    stopRecording,
} from '../../src/record/recording';
import type { RecorderEvent } from '../../src/record/recorder';
import type { StepUnion } from '../../src/runner/steps/types';

test('recordStep appends cross-tab step into sole active recording session', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordings.set('token-a', []);

    const step: StepUnion = {
        id: 'step-1',
        name: 'browser.switch_tab',
        args: { tabName: 'tab-b' },
        meta: { source: 'record', ts: 100, tabName: 'tab-b', workspaceName: 'ws-1' },
    };

    recordStep(state, 'token-b', step, 1200);
    const recorded = state.recordings.get('token-a') || [];
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].name, 'browser.switch_tab');
    assert.equal(recorded[0].meta?.tabName, 'tab-b');
});

test('stopRecording falls back to sole active recording token', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.lastNavigateTs.set('token-a', 1);
    state.lastClickTs.set('token-a', 2);
    state.lastScrollY.set('token-a', 3);

    stopRecording(state, 'token-b');
    assert.equal(state.recordingEnabled.has('token-a'), false);
    assert.equal(state.lastNavigateTs.has('token-a'), false);
    assert.equal(state.lastClickTs.has('token-a'), false);
    assert.equal(state.lastScrollY.has('token-a'), false);
});

test('stopRecording resolves active token by workspaceName', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordingEnabled.add('token-b');
    state.recordings.set('token-a', []);
    state.recordings.set('token-b', []);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceName: 'ws-a',
        startedAt: 1,
        tabs: [],
    });
    state.recordingManifests.set('token-b', {
        recordingToken: 'token-b',
        workspaceName: 'ws-b',
        startedAt: 2,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-a', 'token-a');
    state.workspaceLatestRecording.set('ws-b', 'token-b');

    stopRecording(state, 'unknown-token', { workspaceName: 'ws-b' });
    assert.equal(state.recordingEnabled.has('token-b'), false);
    assert.equal(state.recordingEnabled.has('token-a'), true);
});

test('getRecording/clearRecording fall back to sole recording key', () => {
    const state = createRecordingState();
    const step: StepUnion = {
        id: 'step-only',
        name: 'browser.goto',
        args: { url: 'https://example.com' },
        meta: { source: 'record', ts: 123, tabName: 'token-a' },
    };
    state.recordings.set('token-a', [step]);

    const viaWrongToken = getRecording(state, 'token-b');
    assert.equal(viaWrongToken.length, 1);
    assert.equal(viaWrongToken[0].id, 'step-only');

    clearRecording(state, 'token-b');
    const cleared = getRecording(state, 'token-a');
    assert.equal(cleared.length, 0);
});

test('recording bundle tracks entry and tab context for switch steps', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordings.set('token-a', []);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceName: 'ws-1',
        entryTabRef: 'tab-a',
        entryUrl: 'https://example.com/a',
        startedAt: 1,
        tabs: [
            {
                tabName: 'tab-a',
                tabRef: 'tab-a',
                firstSeenUrl: 'https://example.com/a',
                lastSeenUrl: 'https://example.com/a',
                firstSeenAt: 1,
                lastSeenAt: 1,
            },
        ],
    });
    const switchStep: StepUnion = {
        id: 'switch-1',
        name: 'browser.switch_tab',
        args: { tabName: 'tab-b', tabUrl: 'https://example.com/b', tabRef: 'tab-b' },
        meta: {
            source: 'record',
            ts: 200,
            workspaceName: 'ws-1',
            tabName: 'tab-b',
        },
    };
    recordStep(state, 'token-a', switchStep, 1200);
    const bundle = getRecordingBundle(state, 'token-a');
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].meta?.tabRef, 'tab-b');
    assert.equal(bundle.steps[0].meta?.urlAtRecord, 'https://example.com/b');
    assert.equal(bundle.manifest?.workspaceName, 'ws-1');
    assert.equal(bundle.manifest?.entryTabRef, 'tab-a');
    assert.equal(bundle.manifest?.entryUrl, 'https://example.com/a');
    const tabB = bundle.manifest?.tabs.find((tab) => tab.tabName === 'tab-b');
    assert.equal(tabB?.tabRef, 'tab-b');
    assert.equal(tabB?.lastSeenUrl, 'https://example.com/b');
});

test('cleanupRecording keeps persisted recording data for closed tab token', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordings.set('token-a', [
        {
            id: 'step-a',
            name: 'browser.goto',
            args: { url: 'https://example.com' },
            meta: { source: 'record', ts: 1, tabName: 'token-a', workspaceName: 'ws-1' },
        } as StepUnion,
    ]);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceName: 'ws-1',
        startedAt: 1,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-1', 'token-a');

    cleanupRecording(state, 'token-a');
    const bundle = getRecordingBundle(state, 'other-token', { workspaceName: 'ws-1' });
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].id, 'step-a');
    assert.equal(bundle.manifest?.workspaceName, 'ws-1');
});

test('getRecordingBundle falls back by workspace when tab token changes', () => {
    const state = createRecordingState();
    state.recordings.set('token-a', [
        {
            id: 'step-workspace',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', ts: 2, tabName: 'token-a', workspaceName: 'ws-2' },
        } as StepUnion,
    ]);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceName: 'ws-2',
        startedAt: 2,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-2', 'token-a');

    const bundle = getRecordingBundle(state, 'token-new', { workspaceName: 'ws-2' });
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].id, 'step-workspace');
    assert.equal(bundle.recordingToken, 'token-a');
});

test('saveWorkspaceSnapshot strips tabName from persisted steps', () => {
    const state = createRecordingState();
    const sourceStep: StepUnion = {
        id: 'step-save-1',
        name: 'browser.click',
        args: { selector: '#save' },
        meta: { source: 'record', ts: 10, tabName: 'token-sensitive', workspaceName: 'ws-save' },
    };
    const snapshot = saveWorkspaceSnapshot(state, {
        workspaceName: 'ws-save',
        tabs: [{ tabName: 'tab-1', url: 'https://example.com', title: 'Example', active: true }],
        recordingToken: 'rec-1',
        steps: [sourceStep],
        manifest: {
            recordingToken: 'rec-1',
            workspaceName: 'ws-save',
            startedAt: 10,
            tabs: [
                {
                    tabName: 'tab-1',
                    tabRef: 'tab-1',
                    firstSeenUrl: 'https://example.com',
                    lastSeenUrl: 'https://example.com',
                    firstSeenAt: 10,
                    lastSeenAt: 10,
                },
            ],
        },
    });
    assert.equal(snapshot.recording.steps.length, 1);
    assert.equal(snapshot.recording.steps[0].meta?.tabName, undefined);
    assert.equal('tabName' in (snapshot.recording.manifest?.tabs[0] || {}), true);
    assert.equal(getWorkspaceSnapshot(state, 'ws-save')?.recording.steps[0].meta?.tabName, undefined);
    const summaries = listWorkspaceRecordings(state);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].workspaceName, 'ws-save');
    assert.equal(summaries[0].stepCount, 1);
});

test('recording enhancements are stored as sidecar and never mixed into step', () => {
    const state = createRecordingState();
    const step: StepUnion = {
        id: 'step-sidecar-1',
        name: 'browser.click',
        args: { selector: '#buy' },
        meta: { source: 'record', ts: 100, tabName: 'token-a', workspaceName: 'ws-1' },
    };
    state.recordings.set('token-a', [step]);
    state.recordingEnhancements.set('token-a', {
        'step-sidecar-1': {
            version: 1,
            eventType: 'click',
            rawContext: { pageUrl: 'https://example.com' },
            resolveHint: {
                target: { nodeId: 'button_buy', role: 'button', primaryDomId: '101' },
                raw: { selector: '#buy' },
            },
            resolvePolicy: { allowFuzzy: true, requireVisible: true },
            target: { nodeId: 'button_buy', role: 'button', primaryDomId: '101' },
        },
    });

    const bundle = getRecordingBundle(state, 'token-a');
    assert.equal((bundle.steps[0].meta as Record<string, unknown>).recording, undefined);
    assert.equal(bundle.enrichments?.['step-sidecar-1']?.target?.nodeId, 'button_buy');
    assert.equal(bundle.enrichments?.['step-sidecar-1']?.resolvePolicy?.allowFuzzy, true);
});

test('recordEvent is ignored after stopRecording', async () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordings.set('token-a', []);
    stopRecording(state, 'token-a');

    const event: RecorderEvent = {
        tabName: 'token-a',
        ts: Date.now(),
        type: 'click',
        selector: '#btn',
        a11yHint: { role: 'button', name: 'Submit' },
    };
    await recordEvent(state, event, 1200);
    assert.equal((state.recordings.get('token-a') || []).length, 0);
});
