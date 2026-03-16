import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState, recordStep } from '../../src/record/recording';
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
