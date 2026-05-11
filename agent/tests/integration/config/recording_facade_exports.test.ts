import test from 'node:test';
import assert from 'node:assert/strict';
import * as recording from '../../src/record/recording';

test('recording facade keeps key exports', () => {
    assert.equal(typeof recording.createRecordingState, 'function');
    assert.equal(typeof recording.appendWorkspaceRecordingEvent, 'function');
    assert.equal(typeof recording.appendWorkspaceRecordingStep, 'function');
    assert.equal(typeof recording.enableWorkspaceRecording, 'function');
    assert.equal(typeof recording.disableWorkspaceRecording, 'function');
    assert.equal(typeof recording.getWorkspaceUnsavedRecordingBundle, 'function');
    assert.equal(typeof recording.normalizeRecordingStepOrder, 'function');
    assert.equal(typeof recording.awaitRecordingEnhancements, 'function');
    assert.equal(typeof recording.ensureRecorder, 'function');
});
