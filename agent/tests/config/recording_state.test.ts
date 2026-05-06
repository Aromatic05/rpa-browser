import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    cleanupRecording,
    createRecordingState,
    disableWorkspaceRecording,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
} from '../../src/record/recording';
import type { RecorderEvent } from '../../src/record/recorder';
import type { StepUnion } from '../../src/runner/steps/types';

test('workspace recording writes to unsaved slot with real tabName', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1', { entryTabRef: 'tab-a', entryUrl: 'https://a.com' });
    enableWorkspaceRecording(state, 'ws-1');

    const event: RecorderEvent = {
        tabName: 'tab-a',
        ts: Date.now(),
        type: 'click',
        selector: '#submit',
        a11yHint: { role: 'button', name: 'Submit' },
    };

    const result = await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', event, 1200);
    assert.equal(result.accepted, true);
    const bundle = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
    assert.equal(bundle.steps.length, 1);
    assert.equal(bundle.steps[0].meta?.tabName, 'tab-a');
});

test('workspace disabled recording returns accepted=false and does not write', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    disableWorkspaceRecording(state, 'ws-1');

    const result = await appendWorkspaceRecordingEvent(
        state,
        'ws-1',
        'tab-a',
        { tabName: 'tab-a', ts: Date.now(), type: 'click', selector: '#a' },
        1200,
    );
    assert.equal(result.accepted, false);
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.length, 0);
});

test('multiple tab events append into same workspace unsaved slot', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');

    const step: StepUnion = {
        id: 'step-1',
        name: 'browser.click',
        args: { selector: '#a' },
        meta: { source: 'record', ts: Date.now(), workspaceName: 'ws-1' },
    };
    const acceptedA = appendWorkspaceRecordingStep(state, 'ws-1', 'tab-a', step, 1200);
    const acceptedB = appendWorkspaceRecordingStep(state, 'ws-1', 'tab-b', step, 1200);
    assert.equal(acceptedA.accepted, true);
    assert.equal(acceptedB.accepted, true);

    const bundle = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
    assert.equal(bundle.steps.length, 2);
    assert.equal(bundle.steps[0].meta?.tabName, 'tab-a');
    assert.equal(bundle.steps[1].meta?.tabName, 'tab-b');
});

test('cleanupRecording only clears tab transient replay state', () => {
    const state = createRecordingState();
    state.replaying.add('tab-a');
    state.replayCancel.add('tab-a');
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');

    cleanupRecording(state, 'tab-a');

    assert.equal(state.replaying.has('tab-a'), false);
    assert.equal(state.replayCancel.has('tab-a'), false);
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').recordingToken, 'unsaved:ws-1');
});
