import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    createRecordingState,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
    setRecordedStepEnricherForTest,
    disableWorkspaceRecording,
} from '../../src/record/recording';
import type { RecorderEvent } from '../../src/record/capture/recorder';
import { setSelectOptionSnapshotResolverForTest } from '../../src/record/normalizer/select_option';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';

const createNode = (id: string, role = 'generic', controlRef?: string): UnifiedNode => ({
    id,
    role,
    children: [],
    ...(controlRef ? { control: { kind: 'x', ref: controlRef } } : {}),
});

const createSnapshot = (input: {
    nodeId: string;
    selector: string;
    fallback?: string;
    attrs?: Record<string, string>;
    controlRef?: string;
    owner?: string;
    capabilities?: string[];
    kind?: string;
    rootNodeId?: string;
    controlNodeId?: string;
    triggerNodeId?: string;
    optionNodeIds?: string[];
    options?: Array<{ nodeId: string; value?: string; label?: string; text?: string; selected?: boolean }>;
}): SnapshotResult => {
    const nodeId = input.nodeId;
    const controlRef = input.controlRef || 'ref-1';
    const root = createNode('root');
    const target = createNode(nodeId, 'option', controlRef);
    root.children.push(target);
    const nodeIndex: Record<string, UnifiedNode> = { root, [nodeId]: target };
    for (const optionNodeId of input.optionNodeIds || []) {
        nodeIndex[optionNodeId] = createNode(optionNodeId, 'option', controlRef);
    }
    return {
        root,
        nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {
            [nodeId]: {
                origin: { primaryDomId: 'dom-1' },
                direct: {
                    kind: 'css',
                    query: input.selector,
                    fallback: input.fallback,
                    source: 'test',
                },
            },
        },
        bboxIndex: {},
        attrIndex: {
            [nodeId]: input.attrs || {},
        },
        contentStore: {},
        controlIndex: {
            [controlRef]: {
                id: 'component-1',
                kind: input.kind || 'native_select',
                owner: input.owner || 'browser.select_option',
                capabilities: input.capabilities || ['select_option'],
                source: 'test',
                confidence: 1,
                rootNodeId: input.rootNodeId || nodeId,
                controlNodeId: input.controlNodeId,
                triggerNodeId: input.triggerNodeId,
                optionNodeIds: input.optionNodeIds || [],
                state: { expanded: false, multiple: false, disabled: false, readonly: false, focused: false },
                data: {
                    options: input.options || [],
                },
            },
        },
    };
};

const setup = () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    return state;
};

test('normalizer pass keeps click mapping unchanged', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async () => undefined);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 1, type: 'click', selector: '#btn' }, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.click');
    setSelectOptionSnapshotResolverForTest(null);
});

test('normalizer pending does not write step immediately', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({
        nodeId: 'checkbox-1',
        selector: '#c1',
        kind: 'checkbox_group',
        rootNodeId: 'group-1',
        optionNodeIds: ['checkbox-1'],
        options: [{ nodeId: 'checkbox-1', value: 'a', selected: true }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 2, type: 'check', selector: '#c1', inputType: 'checkbox', checked: true }, 1200);
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.length, 0);
    setSelectOptionSnapshotResolverForTest(null);
});

test('native_select select is normalized to browser.select_option without extra fields', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({ nodeId: 'n1', selector: '#country', kind: 'native_select' }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 3, type: 'select', selector: '#country', value: 'CN' }, 1200);
    const step = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps[0];
    assert.equal(step.name, 'browser.select_option');
    assert.deepEqual((step.args as any).values, ['CN']);
    assert.equal('kind' in (step.args as any), false);
    assert.equal('controlRef' in (step.args as any), false);
    assert.equal('searchText' in (step.args as any), false);
    assert.equal('timeout' in (step.args as any), false);
    setSelectOptionSnapshotResolverForTest(null);
});

test('radio_group checked=true normalizes and checked=false ignored', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async (_input) => createSnapshot({
        nodeId: 'r1',
        selector: '#r1',
        kind: 'radio_group',
        rootNodeId: 'rg1',
        optionNodeIds: ['r1'],
        options: [{ nodeId: 'r1', label: 'Label A' }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 4, type: 'check', selector: '#r1', inputType: 'radio', checked: true }, 1200);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 5, type: 'check', selector: '#r1', inputType: 'radio', checked: false }, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.deepEqual((steps[0].args as any).values, ['Label A']);
    setSelectOptionSnapshotResolverForTest(null);
});

test('checkbox_group flush emits final selected collection and suppresses click mapping', async () => {
    const state = setup();
    let selected = ['A', 'B'];
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({
        nodeId: 'cb1',
        selector: '#cb1',
        kind: 'checkbox_group',
        rootNodeId: 'cg1',
        optionNodeIds: ['cb1', 'cb2'],
        options: [
            { nodeId: 'cb1', value: 'A', selected: selected.includes('A') },
            { nodeId: 'cb2', value: 'B', selected: selected.includes('B') },
        ],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 10, type: 'check', selector: '#cb1', inputType: 'checkbox', checked: true }, 1200);
    selected = ['B'];
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 11, type: 'check', selector: '#cb1', inputType: 'checkbox', checked: false }, 1200);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 12, type: 'click', selector: '#other' }, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.select_option');
    assert.deepEqual((steps[0].args as any).values, ['B']);
    assert.equal(steps[1].name, 'browser.click');
    setSelectOptionSnapshotResolverForTest(null);
});

test('custom_select trigger pending and option click merges to select_option', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async (_input) => createSnapshot({
        nodeId: 'trigger',
        selector: '#trigger',
        kind: 'custom_select',
        rootNodeId: 'cs1',
        controlNodeId: 'control',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt1'],
        options: [{ nodeId: 'opt1', text: 'Alpha' }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 20, type: 'click', selector: '#trigger' }, 1200);
    setSelectOptionSnapshotResolverForTest(async (_input) => createSnapshot({
        nodeId: 'opt1',
        selector: '#opt1',
        kind: 'custom_select',
        rootNodeId: 'cs1',
        controlNodeId: 'control',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt1'],
        options: [{ nodeId: 'opt1', text: 'Alpha' }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 21, type: 'click', selector: '#opt1' }, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.deepEqual((steps[0].args as any).values, ['Alpha']);
    setSelectOptionSnapshotResolverForTest(null);
});

test('custom_select unfinished trigger released as click on other click and on stop', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({
        nodeId: 'trigger',
        selector: '#trigger',
        kind: 'custom_select',
        rootNodeId: 'cs1',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt1'],
        options: [{ nodeId: 'opt1', value: 'a' }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 30, type: 'click', selector: '#trigger' }, 1200);
    setSelectOptionSnapshotResolverForTest(async () => undefined);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 31, type: 'click', selector: '#other' }, 1200);
    disableWorkspaceRecording(state, 'ws-1');
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.click');
    assert.equal((steps[0].args as any).selector, '#trigger');
    setSelectOptionSnapshotResolverForTest(null);
});

test('normalizer handled step triggers enrichment pipeline', async () => {
    const state = setup();
    let called = 0;
    setRecordedStepEnricherForTest(async ({ event }) => {
        called += 1;
        return { version: 1, eventType: event.type };
    });
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({ nodeId: 'n1', selector: '#country', kind: 'native_select' }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 40, type: 'select', selector: '#country', value: 'US' }, 1200);
    assert.equal(called, 1);
    setSelectOptionSnapshotResolverForTest(null);
    setRecordedStepEnricherForTest(null);
});

test('boundary pass cases: missing control refs and owner/capabilities/ambiguous selectors', async () => {
    const state = setup();
    const baseEvent: RecorderEvent = { tabName: 'tab-a', ts: 50, type: 'select', selector: '#country', value: 'US' };

    setSelectOptionSnapshotResolverForTest(async () => {
        const snapshot = createSnapshot({ nodeId: 'n1', selector: '#country', controlRef: 'missing' });
        delete (snapshot.controlIndex as any).missing;
        return snapshot;
    });
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { ...baseEvent, ts: 51 }, 1200);

    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({ nodeId: 'n1', selector: '#country', owner: 'browser.click' }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { ...baseEvent, ts: 52 }, 1200);

    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({ nodeId: 'n1', selector: '#country', capabilities: [] }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { ...baseEvent, ts: 53 }, 1200);

    setSelectOptionSnapshotResolverForTest(async () => {
        const snapshot = createSnapshot({ nodeId: 'n1', selector: '#country' });
        snapshot.locatorIndex.n2 = snapshot.locatorIndex.n1;
        snapshot.nodeIndex.n2 = createNode('n2', 'option', 'ref-1');
        return snapshot;
    });
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { ...baseEvent, ts: 54 }, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.every((step) => step.name === 'browser.select_option'), true);
    setSelectOptionSnapshotResolverForTest(null);
});

test('source guards for forbidden protocol strings', () => {
    const normalizerSrc = fs.readFileSync('src/record/normalizer/select_option.ts', 'utf8');
    assert.equal(normalizerSrc.includes('getByText'), false);
    assert.equal(normalizerSrc.includes('has-text'), false);

    const payloadSrc = fs.readFileSync('src/record/capture/payload/index.ts', 'utf8');
    assert.equal(payloadSrc.includes('custom_select'), false);
    assert.equal(payloadSrc.includes('controlRef'), false);

    const stepTypesSrc = fs.readFileSync('src/runner/steps/types.ts', 'utf8');
    assert.equal(stepTypesSrc.includes("'browser.select_option': {\n        nodeId?: string;\n        selector?: string;\n        resolveId?: string;\n        values: string[];\n    };"), true);
});

// explicit flush path through append step boundary

test('appendWorkspaceRecordingStep flushes pending checkbox session first', async () => {
    const state = setup();
    setSelectOptionSnapshotResolverForTest(async () => createSnapshot({
        nodeId: 'cb1',
        selector: '#cb1',
        kind: 'checkbox_group',
        rootNodeId: 'cg1',
        optionNodeIds: ['cb1'],
        options: [{ nodeId: 'cb1', value: 'A', selected: true }],
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 60, type: 'check', selector: '#cb1', inputType: 'checkbox', checked: true }, 1200);
    appendWorkspaceRecordingStep(state, 'ws-1', 'tab-a', {
        id: 'external-1',
        name: 'browser.click',
        args: { selector: '#x' },
        meta: { source: 'record', ts: 61, tabName: 'tab-a' },
    } as any, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal(steps[1].id, 'external-1');
    setSelectOptionSnapshotResolverForTest(null);
});
