import test from 'node:test';
import assert from 'node:assert/strict';
import {
    awaitRecordingEnhancements,
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    cleanupRecording,
    createRecordingState,
    disableWorkspaceRecording,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    normalizeRecordingStepOrder,
    resetWorkspaceUnsavedRecording,
    setRecordedStepEnricherForTest,
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

test('delayed click enrichment does not block enqueue order against later navigate', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    let resolveClick!: () => void;
    const clickGate = new Promise<void>((resolve) => {
        resolveClick = resolve;
    });
    setRecordedStepEnricherForTest(async ({ event }) => {
        if (event.type === 'click') {
            await clickGate;
        }
        return { version: 1, eventType: event.type };
    });
    try {
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: 1000,
            type: 'click',
            selector: '#a',
        }, 1200);
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: 3000,
            type: 'navigate',
            url: 'https://example.com/next',
        }, 1200);
        const beforeResolve = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
        assert.deepEqual(beforeResolve.steps.map((step) => step.name), ['browser.click', 'browser.goto']);
        resolveClick();
        await awaitRecordingEnhancements(state, 'ws-1');
    } finally {
        setRecordedStepEnricherForTest(null);
    }
});

test('appendWorkspaceRecordingEvent increases stepCount before enrichment resolves', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    setRecordedStepEnricherForTest(async ({ event }) => {
        await gate;
        return { version: 1, eventType: event.type, resolveHint: { raw: { selector: '#a' } } };
    });
    try {
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: 100,
            type: 'click',
            selector: '#a',
        }, 1200);
        const current = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
        assert.equal(current.steps.length, 1);
        assert.equal(Object.keys(current.enrichments).length, 0);
        release();
        await awaitRecordingEnhancements(state, 'ws-1');
        const after = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
        assert.equal(Boolean(after.enrichments[after.steps[0].id]), true);
    } finally {
        setRecordedStepEnricherForTest(null);
    }
});

test('enrichment failure does not delete step', async () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    setRecordedStepEnricherForTest(async () => {
        throw new Error('boom');
    });
    try {
        await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
            tabName: 'tab-a',
            ts: 100,
            type: 'click',
            selector: '#a',
        }, 1200);
        await awaitRecordingEnhancements(state, 'ws-1');
        const bundle = getWorkspaceUnsavedRecordingBundle(state, 'ws-1');
        assert.equal(bundle.steps.length, 1);
        assert.equal(Object.keys(bundle.enrichments).length, 0);
    } finally {
        setRecordedStepEnricherForTest(null);
    }
});

test('normalizeRecordingStepOrder sorts by ts and preserves tie order', () => {
    const steps: StepUnion[] = [
        { id: 'b', name: 'browser.click', args: {}, meta: { source: 'record', ts: 2200, tabName: 'tab-a' } } as any,
        { id: 'a', name: 'browser.goto', args: { url: 'u' }, meta: { source: 'record', ts: 10, tabName: 'tab-a' } } as any,
        { id: 'c', name: 'browser.fill', args: {}, meta: { source: 'record', ts: 2200, tabName: 'tab-a' } } as any,
    ];
    const ordered = normalizeRecordingStepOrder(steps, 1200);
    assert.deepEqual(ordered.map((step) => step.id), ['a', 'b', 'c']);
});

test('normalizeRecordingStepOrder keeps same-tab click before goto within nav window', () => {
    const steps: StepUnion[] = [
        { id: 'g', name: 'browser.goto', args: { url: 'u' }, meta: { source: 'record', ts: 1010, tabName: 'tab-a' } } as any,
        { id: 'c', name: 'browser.click', args: {}, meta: { source: 'record', ts: 1000, tabName: 'tab-a' } } as any,
    ];
    const ordered = normalizeRecordingStepOrder(steps, 20);
    assert.deepEqual(ordered.map((step) => step.id), ['c', 'g']);
});

test('normalizeRecordingStepOrder does not cross-tab reorder for click/goto override', () => {
    const steps: StepUnion[] = [
        { id: 'g', name: 'browser.goto', args: { url: 'u' }, meta: { source: 'record', ts: 1000, tabName: 'tab-b' } } as any,
        { id: 'c', name: 'browser.click', args: {}, meta: { source: 'record', ts: 1001, tabName: 'tab-a' } } as any,
    ];
    const ordered = normalizeRecordingStepOrder(steps, 20);
    assert.deepEqual(ordered.map((step) => step.id), ['g', 'c']);
});
