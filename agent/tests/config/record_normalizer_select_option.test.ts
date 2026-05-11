import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    appendWorkspaceRecordingEvent,
    appendWorkspaceRecordingStep,
    createRecordingState,
    disableWorkspaceRecording,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
} from '../../src/record/recording';
import type { RecorderEvent } from '../../src/record/capture/recorder';
import { setRecordTargetSnapshotResolverForTest } from '../../src/record/pipeline/target_binding';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';

const node = (id: string, role = 'generic', controlRef?: string): UnifiedNode => ({
    id,
    role,
    children: [],
    ...(controlRef ? { control: { kind: 'x', ref: controlRef } } : {}),
});

const baseState = () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    return state;
};

const snapshotFor = (input: {
    selector: string;
    targetNodeId: string;
    controlRef: string;
    componentKind: 'native_select' | 'radio_group' | 'checkbox_group' | 'custom_select';
    owner?: string;
    capabilities?: string[];
    rootNodeId: string;
    controlNodeId?: string;
    triggerNodeId?: string;
    optionNodeIds?: string[];
    options?: Array<{ nodeId: string; value?: string; label?: string; text?: string; selected?: boolean }>;
    attachTargetControlRef?: boolean;
}): SnapshotResult => {
    const root = node('root');
    const target = node(input.targetNodeId, 'option', input.attachTargetControlRef === false ? undefined : input.controlRef);
    root.children.push(target);
    const nodeIndex: Record<string, UnifiedNode> = { root, [target.id]: target };
    for (const optionNodeId of input.optionNodeIds || []) {
        if (!nodeIndex[optionNodeId]) {
            nodeIndex[optionNodeId] = node(optionNodeId, 'option');
        }
    }

    return {
        root,
        nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {
            [input.targetNodeId]: {
                origin: { primaryDomId: 'd1' },
                direct: { kind: 'css', query: input.selector, source: 'test' },
            },
        },
        bboxIndex: {},
        attrIndex: { [input.targetNodeId]: {} },
        contentStore: {},
        controlIndex: {
            [input.controlRef]: {
                id: 'c1',
                kind: input.componentKind,
                owner: input.owner || 'browser.select_option',
                capabilities: input.capabilities || ['select_option'],
                source: 'test',
                confidence: 1,
                rootNodeId: input.rootNodeId,
                controlNodeId: input.controlNodeId,
                triggerNodeId: input.triggerNodeId,
                optionNodeIds: input.optionNodeIds || [],
                state: { expanded: false, multiple: false, disabled: false, readonly: false, focused: false },
                data: { options: input.options || [] },
            },
        },
    };
};

test('checkbox option node without node.control.ref can bind by optionNodeIds and flush one select_option', async () => {
    const state = baseState();
    let selected = ['yellow'];
    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'opt-yellow',
        controlRef: 'ref-checkbox',
        componentKind: 'checkbox_group',
        rootNodeId: 'group-root',
        optionNodeIds: ['opt-yellow', 'opt-green'],
        options: [
            { nodeId: 'opt-yellow', value: 'yellow', selected: selected.includes('yellow') },
            { nodeId: 'opt-green', value: 'green', selected: selected.includes('green') },
        ],
        attachTargetControlRef: false,
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 1, type: 'check', inputType: 'checkbox', checked: true, selector: '#yellow',
    }, 1200);
    assert.equal(getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps.length, 0);

    selected = ['yellow', 'green'];
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 2, type: 'check', inputType: 'checkbox', checked: true, selector: '#green',
    }, 1200);

    appendWorkspaceRecordingStep(state, 'ws-1', 'tab-a', {
        id: 'external', name: 'browser.click', args: { selector: '#submit' }, meta: { source: 'record', ts: 3, tabName: 'tab-a' },
    } as any, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal((steps[0].args as any).kind, 'checkbox_group');
    assert.deepEqual((steps[0].args as any).values, ['yellow', 'green']);
    assert.equal(steps[1].id, 'external');
    setRecordTargetSnapshotResolverForTest(null);
});

test('radio checked true normalizes select_option by option node binding and no click', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'radio-c',
        controlRef: 'ref-radio',
        componentKind: 'radio_group',
        rootNodeId: 'radio-root',
        optionNodeIds: ['radio-a', 'radio-c'],
        options: [{ nodeId: 'radio-c', label: 'C' }],
        attachTargetControlRef: false,
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 10, type: 'check', inputType: 'radio', checked: true, selector: '#radio-c',
    }, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal((steps[0].args as any).kind, 'radio_group');
    assert.deepEqual((steps[0].args as any).values, ['C']);
    setRecordTargetSnapshotResolverForTest(null);
});

test('native select select suppresses near click echo', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'select-1',
        controlRef: 'ref-select',
        componentKind: 'native_select',
        rootNodeId: 'select-1',
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 20, type: 'select', selector: '#native', value: '2',
    }, 1200);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 21, type: 'click', selector: '#native',
    }, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal((steps[0].args as any).kind, 'native_select');
    setRecordTargetSnapshotResolverForTest(null);
});

test('custom select trigger pending + option click merges, unfinished trigger releases then keeps current click', async () => {
    const state = baseState();

    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'trigger',
        controlRef: 'ref-custom',
        componentKind: 'custom_select',
        rootNodeId: 'custom-root',
        controlNodeId: 'control',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt-1'],
        options: [{ nodeId: 'opt-1', text: 'B' }],
        attachTargetControlRef: false,
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 30, type: 'click', selector: '#trigger' }, 1200);

    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'opt-1',
        controlRef: 'ref-custom',
        componentKind: 'custom_select',
        rootNodeId: 'custom-root',
        controlNodeId: 'control',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt-1'],
        options: [{ nodeId: 'opt-1', text: 'B' }],
        attachTargetControlRef: false,
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 31, type: 'click', selector: '#opt-1' }, 1200);
    const merged = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].name, 'browser.select_option');
    assert.equal((merged[0].args as any).kind, 'custom_select');

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 40, type: 'click', selector: '#trigger' }, 1200);
    setRecordTargetSnapshotResolverForTest(async () => undefined);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 41, type: 'click', selector: '#other' }, 1200);

    const released = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(released[1].name, 'browser.click');
    assert.equal((released[1].args as any).selector, '#trigger');
    assert.equal(released[2].name, 'browser.click');
    assert.equal((released[2].args as any).selector, '#other');

    setRecordTargetSnapshotResolverForTest(null);
});

test('snapshot missing and owner/capability mismatch pass to click', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async () => undefined);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 50, type: 'click', selector: '#x' }, 1200);

    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'opt',
        controlRef: 'ref',
        componentKind: 'radio_group',
        rootNodeId: 'r',
        owner: 'browser.click',
    }));
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 51, type: 'click', selector: '#y' }, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.click');
    assert.equal(steps[1].name, 'browser.click');
    setRecordTargetSnapshotResolverForTest(null);
});

test('source guards', () => {
    const normalizerSrc = fs.readFileSync('src/record/normalizer/select_option.ts', 'utf8');
    assert.equal(normalizerSrc.includes('getByText'), false);
    assert.equal(normalizerSrc.includes('has-text'), false);

    const payloadSrc = fs.readFileSync('src/record/capture/payload/index.ts', 'utf8');
    assert.equal(payloadSrc.includes('custom_select'), false);
    assert.equal(payloadSrc.includes('controlRef'), false);

    const stepTypesSrc = fs.readFileSync('src/runner/steps/types.ts', 'utf8');
    assert.equal(stepTypesSrc.includes("'browser.select_option': {\n        nodeId?: string;\n        selector?: string;\n        resolveId?: string;\n        kind: SelectOptionKind;\n        values: string[];\n    };"), true);
});

test('native select suppress normalizes selector whitespace', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'select-2',
        controlRef: 'ref-select-2',
        componentKind: 'native_select',
        rootNodeId: 'select-2',
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 90, type: 'select', selector: '#native-select', value: '2',
    }, 1200);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 91, type: 'click', selector: '  #native-select \n',
    }, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal((steps[0].args as any).kind, 'native_select');
    setRecordTargetSnapshotResolverForTest(null);
});

test('stop flush releases unfinished custom trigger click', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async ({ event }) => snapshotFor({
        selector: event.selector || '',
        targetNodeId: 'trigger',
        controlRef: 'ref-custom',
        componentKind: 'custom_select',
        rootNodeId: 'custom-root',
        controlNodeId: 'control',
        triggerNodeId: 'trigger',
        optionNodeIds: ['opt-1'],
        options: [{ nodeId: 'opt-1', text: 'B' }],
        attachTargetControlRef: false,
    }));

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', { tabName: 'tab-a', ts: 80, type: 'click', selector: '#trigger' }, 1200);
    disableWorkspaceRecording(state, 'ws-1');
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps[0].name, 'browser.click');
    assert.equal((steps[0].args as any).selector, '#trigger');
    setRecordTargetSnapshotResolverForTest(null);
});
