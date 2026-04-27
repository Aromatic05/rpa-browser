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
    saveWorkspaceSnapshot,
    stopRecording,
} from '../../src/record/recording';
import type { StepUnion } from '../../src/runner/steps/types';

test('recordStep appends cross-tab step into sole active recording session', () => {
    const state = createRecordingState();
    state.recordingEnabled.add('token-a');
    state.recordings.set('token-a', []);

    const step: StepUnion = {
        id: 'step-1',
        name: 'browser.switch_tab',
        args: { tabId: 'tab-b' },
        meta: { source: 'record', ts: 100, tabToken: 'token-b', workspaceId: 'ws-1', tabId: 'tab-b' },
    };

    recordStep(state, 'token-b', step, 1200);
    const recorded = state.recordings.get('token-a') || [];
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].name, 'browser.switch_tab');
    assert.equal(recorded[0].meta?.tabToken, 'token-b');
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

test('getRecording/clearRecording fall back to sole recording key', () => {
    const state = createRecordingState();
    const step: StepUnion = {
        id: 'step-only',
        name: 'browser.goto',
        args: { url: 'https://example.com' },
        meta: { source: 'record', ts: 123, tabToken: 'token-a' },
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
        workspaceId: 'ws-1',
        entryTabRef: 'tab-a',
        entryUrl: 'https://example.com/a',
        startedAt: 1,
        tabs: [
            {
                tabToken: 'token-a',
                tabRef: 'tab-a',
                tabId: 'tab-a',
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
        args: { tabId: 'tab-b', tabUrl: 'https://example.com/b', tabRef: 'tab-b' },
        meta: {
            source: 'record',
            ts: 200,
            workspaceId: 'ws-1',
            tabId: 'tab-b',
            tabToken: 'token-b',
        },
    };
    recordStep(state, 'token-a', switchStep, 1200);
    const bundle = getRecordingBundle(state, 'token-a');
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].meta?.tabRef, 'tab-b');
    assert.equal(bundle.steps[0].meta?.urlAtRecord, 'https://example.com/b');
    assert.equal(bundle.manifest?.workspaceId, 'ws-1');
    assert.equal(bundle.manifest?.entryTabRef, 'tab-a');
    assert.equal(bundle.manifest?.entryUrl, 'https://example.com/a');
    const tabB = bundle.manifest?.tabs.find((tab) => tab.tabToken === 'token-b');
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
            meta: { source: 'record', ts: 1, tabToken: 'token-a', workspaceId: 'ws-1' },
        } as StepUnion,
    ]);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceId: 'ws-1',
        startedAt: 1,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-1', 'token-a');

    cleanupRecording(state, 'token-a');
    const bundle = getRecordingBundle(state, 'other-token', { workspaceId: 'ws-1' });
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].id, 'step-a');
    assert.equal(bundle.manifest?.workspaceId, 'ws-1');
});

test('getRecordingBundle falls back by workspace when tab token changes', () => {
    const state = createRecordingState();
    state.recordings.set('token-a', [
        {
            id: 'step-workspace',
            name: 'browser.click',
            args: { selector: '#a' },
            meta: { source: 'record', ts: 2, tabToken: 'token-a', workspaceId: 'ws-2' },
        } as StepUnion,
    ]);
    state.recordingManifests.set('token-a', {
        recordingToken: 'token-a',
        workspaceId: 'ws-2',
        startedAt: 2,
        tabs: [],
    });
    state.workspaceLatestRecording.set('ws-2', 'token-a');

    const bundle = getRecordingBundle(state, 'token-new', { workspaceId: 'ws-2' });
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].id, 'step-workspace');
    assert.equal(bundle.recordingToken, 'token-a');
});

test('saveWorkspaceSnapshot strips tabToken from persisted steps', () => {
    const state = createRecordingState();
    const sourceStep: StepUnion = {
        id: 'step-save-1',
        name: 'browser.click',
        args: { selector: '#save' },
        meta: { source: 'record', ts: 10, tabToken: 'token-sensitive', workspaceId: 'ws-save' },
    };
    const snapshot = saveWorkspaceSnapshot(state, {
        workspaceId: 'ws-save',
        tabs: [{ tabId: 'tab-1', url: 'https://example.com', title: 'Example', active: true }],
        recordingToken: 'rec-1',
        steps: [sourceStep],
        manifest: {
            recordingToken: 'rec-1',
            workspaceId: 'ws-save',
            startedAt: 10,
            tabs: [
                {
                    tabToken: 'token-sensitive',
                    tabRef: 'tab-1',
                    tabId: 'tab-1',
                    firstSeenUrl: 'https://example.com',
                    lastSeenUrl: 'https://example.com',
                    firstSeenAt: 10,
                    lastSeenAt: 10,
                },
            ],
        },
    });
    assert.equal(snapshot.recording.steps.length, 1);
    assert.equal(snapshot.recording.steps[0].meta?.tabToken, undefined);
    assert.equal('tabToken' in (snapshot.recording.manifest?.tabs[0] || {}), false);
    assert.equal(getWorkspaceSnapshot(state, 'ws-save')?.recording.steps[0].meta?.tabToken, undefined);
    const summaries = listWorkspaceRecordings(state);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].workspaceId, 'ws-save');
    assert.equal(summaries[0].stepCount, 1);
});

test('recording enhancements are stored as sidecar and never mixed into step', () => {
    const state = createRecordingState();
    const step: StepUnion = {
        id: 'step-sidecar-1',
        name: 'browser.click',
        args: { selector: '#buy' },
        meta: { source: 'record', ts: 100, tabToken: 'token-a', workspaceId: 'ws-1' },
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
