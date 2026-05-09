import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordingState, resetWorkspaceUnsavedRecording, enableWorkspaceRecording, getWorkspaceUnsavedToken } from '../../src/record/recording';
import { recordFirstTabPageUrl, recordTabActivated, recordTabClosed, recordTabCreated } from '../../src/record/tab_lifecycle_recorder';

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
    assert.equal(Object.hasOwn(steps[0].args as Record<string, unknown>, 'url'), false);
    assert.equal(steps[0].meta?.tabName, 'tab-a');
    assert.equal(steps[0].meta?.tabRef, 'tab-a');
    assert.equal(steps[0].meta?.urlAtRecord, 'https://a');
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

test('recordFirstTabPageUrl records first ordinary page url after new tab lifecycle', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'about:blank', at: 1, navDedupeWindowMs: 0 });
    recordTabActivated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'about:blank', at: 2, navDedupeWindowMs: 0 });
    recordFirstTabPageUrl(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', url: 'https://catos.info/', at: 3, navDedupeWindowMs: 0 });
    const steps = getSteps(state, workspaceName);
    assert.deepEqual(steps.map((step) => step.name), ['browser.create_tab', 'browser.switch_tab', 'browser.goto']);
    assert.equal((steps[2].args as { url?: string }).url, 'https://catos.info/');
    assert.equal(steps[2].meta?.source, 'record');
    assert.equal(steps[2].meta?.ts, 3);
    assert.equal(steps[2].meta?.workspaceName, workspaceName);
    assert.equal(steps[2].meta?.tabName, 'tab-a');
    assert.equal(steps[2].meta?.tabRef, 'tab-a');
    assert.equal(steps[2].meta?.urlAtRecord, 'https://catos.info/');
});

test('recordFirstTabPageUrl ignores non ordinary page urls', () => {
    const blockedUrls = ['about:blank', 'about:newtab', 'chrome://newtab', 'chrome://settings', 'edge://newtab', 'devtools://devtools/bundled/inspector.html'];
    for (const url of blockedUrls) {
        const { state, workspaceName } = setupRecording();
        recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: url, navDedupeWindowMs: 0 });
        recordFirstTabPageUrl(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', url, navDedupeWindowMs: 0 });
        assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.goto'), false, url);
    }
});

test('recordFirstTabPageUrl dedupes same first url for same tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'about:blank', navDedupeWindowMs: 0 });
    recordFirstTabPageUrl(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', url: 'https://catos.info/', navDedupeWindowMs: 0 });
    recordFirstTabPageUrl(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', url: 'https://catos.info/', navDedupeWindowMs: 0 });
    const gotos = getSteps(state, workspaceName).filter((step) => step.name === 'browser.goto');
    assert.equal(gotos.length, 1);
});

test('recordTabCreated does not append switch_tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.switch_tab'), false);
});

test('recordTabCreated does not append goto', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.goto'), false);
});

test('recordTabClosed does not append switch_tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabClosed(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).some((step) => step.name === 'browser.switch_tab'), false);
});

test('recordTabActivated dedupes consecutive same switch_tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabActivated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    recordTabActivated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).filter((step) => step.name === 'browser.switch_tab').length, 1);
});

test('recordTabCreated dedupes repeated create_tab for same tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    recordTabCreated(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).filter((step) => step.name === 'browser.create_tab').length, 1);
});

test('recordTabClosed dedupes repeated close_tab for same tab', () => {
    const { state, workspaceName } = setupRecording();
    recordTabClosed(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    recordTabClosed(state, { workspaceName, tabName: 'tab-a', tabRef: 'tab-a', urlAtRecord: 'https://a', navDedupeWindowMs: 1200 });
    assert.equal(getSteps(state, workspaceName).filter((step) => step.name === 'browser.close_tab').length, 1);
});
