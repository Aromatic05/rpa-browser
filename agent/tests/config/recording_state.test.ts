import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clearRecording,
    createRecordingState,
    getRecording,
    getRecordingBundle,
    recordStep,
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
        args: { tab_id: 'tab-b' },
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
        args: { tab_id: 'tab-b', tab_url: 'https://example.com/b', tab_ref: 'tab-b' },
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
