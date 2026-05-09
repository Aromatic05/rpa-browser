import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState, resetWorkspaceUnsavedRecording, enableWorkspaceRecording, getWorkspaceUnsavedToken } from '../../src/record/recording';
import { recordTabActivated, recordTabClosed, recordTabCreated } from '../../src/record/tab_lifecycle_recorder';

const getSteps = (state: ReturnType<typeof createRecordingState>, workspaceName: string) =>
    state.recordings.get(getWorkspaceUnsavedToken(state, workspaceName)) || [];

const setupRecording = () => {
    const state = createRecordingState();
    const workspaceName = 'ws-tab-lifecycle';
    resetWorkspaceUnsavedRecording(state, workspaceName);
    enableWorkspaceRecording(state, workspaceName);
    return { state, workspaceName };
};

test('recordTabCreated appends browser.create_tab only', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    const steps = getSteps(state, workspaceName);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.create_tab');
});

test('recordTabActivated appends browser.switch_tab only', () => {
    const { state, workspaceName } = setupRecording();
    recordTabActivated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    const steps = getSteps(state, workspaceName);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.switch_tab');
});

test('recordTabClosed appends browser.close_tab only', () => {
    const { state, workspaceName } = setupRecording();
    recordTabClosed(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    const steps = getSteps(state, workspaceName);
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.close_tab');
});

test('recordTabCreated does not append switch_tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.switch_tab'), false);
});

test('recordTabClosed does not append switch_tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabClosed(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.switch_tab'), false);
});
