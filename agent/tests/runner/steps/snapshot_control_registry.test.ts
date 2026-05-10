import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createControlRegistry,
    registerControlCollector,
    listControlCollectors,
    collectControlComponents,
    attachControlRefsToNodes,
    buildControlRef,
} from '../../../src/runner/steps/executors/snapshot/control';
import type {
    ControlCollector,
    ControlRegistry,
    BaseControlComponent,
} from '../../../src/runner/steps/executors/snapshot/control/types';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const makeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const makeComponent = (overrides: Partial<BaseControlComponent> = {}): BaseControlComponent => ({
    id: 'c1',
    kind: 'test_kind',
    owner: 'test.owner',
    capabilities: ['test_cap'],
    source: 'auto',
    confidence: 1,
    rootNodeId: 'n1',
    controlNodeId: 'n1',
    triggerNodeId: 'n1',
    popupNodeId: '',
    labelNodeId: '',
    valueNodeId: '',
    optionNodeIds: [],
    state: {
        expanded: false,
        multiple: false,
        disabled: false,
        readonly: false,
        focused: false,
    },
    data: {},
    ...overrides,
});

test('createControlRegistry returns empty registry', () => {
    const registry = createControlRegistry();
    assert.deepStrictEqual(registry, { collectors: [] });
});

test('registerControlCollector adds collector to registry', () => {
    const registry = createControlRegistry();
    const collector: ControlCollector = () => [];
    registerControlCollector(registry, collector);
    assert.strictEqual(registry.collectors.length, 1);
    assert.strictEqual(registry.collectors[0], collector);
});

test('listControlCollectors returns all registered collectors', () => {
    const registry = createControlRegistry();
    const c1: ControlCollector = () => [];
    const c2: ControlCollector = () => [];
    registerControlCollector(registry, c1);
    registerControlCollector(registry, c2);
    assert.strictEqual(listControlCollectors(registry).length, 2);
});

test('collectControlComponents invokes all collectors and merges results', () => {
    const registry = createControlRegistry();
    const comp1 = makeComponent({ id: 'a', kind: 'k1', rootNodeId: 'r1' });
    const comp2 = makeComponent({ id: 'b', kind: 'k2', rootNodeId: 'r2' });
    registerControlCollector(registry, () => [comp1]);
    registerControlCollector(registry, () => [comp2]);

    const root = makeNode('root', 'root');
    const nodeIndex: Record<string, UnifiedNode> = { root, r1: makeNode('r1', 'generic'), r2: makeNode('r2', 'generic') };

    const controlIndex = collectControlComponents(root, nodeIndex, registry);
    assert.strictEqual(Object.keys(controlIndex).length, 2);
    const ref1 = buildControlRef('k1', 'r1');
    const ref2 = buildControlRef('k2', 'r2');
    assert.ok(controlIndex[ref1]);
    assert.ok(controlIndex[ref2]);
    assert.strictEqual(controlIndex[ref1].id, 'a');
    assert.strictEqual(controlIndex[ref2].id, 'b');
});

test('collectControlComponents skips duplicate refs keeping first occurrence', () => {
    const registry = createControlRegistry();
    const comp1 = makeComponent({ id: 'first', kind: 'k', rootNodeId: 'r' });
    const comp2 = makeComponent({ id: 'second', kind: 'k', rootNodeId: 'r' });
    registerControlCollector(registry, () => [comp1]);
    registerControlCollector(registry, () => [comp2]);

    const root = makeNode('root', 'root');
    const nodeIndex: Record<string, UnifiedNode> = { root, r: makeNode('r', 'generic') };

    const controlIndex = collectControlComponents(root, nodeIndex, registry);
    assert.strictEqual(Object.keys(controlIndex).length, 1);
    const ref = buildControlRef('k', 'r');
    assert.strictEqual(controlIndex[ref].id, 'first');
});

test('buildControlRef generates control:<kind>:<rootNodeId>', () => {
    assert.strictEqual(buildControlRef('native_select', 'n42'), 'control:native_select:n42');
    assert.strictEqual(buildControlRef('radio_group', 'abc'), 'control:radio_group:abc');
});

test('attachControlRefsToNodes attaches control ref to relevant nodes', () => {
    const controlIndex: Record<string, BaseControlComponent> = {};
    const comp = makeComponent({
        id: 'c1',
        kind: 'test',
        rootNodeId: 'root',
        controlNodeId: 'ctrl',
        triggerNodeId: 'trig',
        popupNodeId: 'pop',
        labelNodeId: 'lbl',
        valueNodeId: 'val',
        optionNodeIds: ['opt1', 'opt2'],
    });
    const ref = buildControlRef('test', 'root');
    controlIndex[ref] = comp;

    const nRoot = makeNode('root', 'generic');
    const nCtrl = makeNode('ctrl', 'generic');
    const nTrig = makeNode('trig', 'generic');
    const nPop = makeNode('pop', 'generic');
    const nLbl = makeNode('lbl', 'generic');
    const nVal = makeNode('val', 'generic');
    const nOpt1 = makeNode('opt1', 'generic');
    const nOpt2 = makeNode('opt2', 'generic');
    const nOther = makeNode('other', 'generic');

    const tree: UnifiedNode = {
        id: 'top',
        role: 'root',
        children: [nRoot, nCtrl, nTrig, nPop, nLbl, nVal, nOpt1, nOpt2, nOther],
    };

    attachControlRefsToNodes(tree, controlIndex);

    assert.deepStrictEqual(nRoot.control, { kind: 'test', ref });
    assert.deepStrictEqual(nCtrl.control, { kind: 'test', ref });
    assert.deepStrictEqual(nOpt1.control, { kind: 'test', ref });
    assert.deepStrictEqual(nOpt2.control, { kind: 'test', ref });
    assert.strictEqual(nOther.control, undefined);
});

test('attachControlRefsToNodes does not attach when controlIndex is empty', () => {
    const tree: UnifiedNode = { id: 'top', role: 'root', children: [] };
    attachControlRefsToNodes(tree, {});
    assert.strictEqual(tree.control, undefined);
});

test('attachControlRefsToNodes handles empty nodeId fields gracefully', () => {
    const controlIndex: Record<string, BaseControlComponent> = {};
    const comp = makeComponent({
        id: 'c1',
        kind: 'test',
        rootNodeId: 'root',
        controlNodeId: '',
        triggerNodeId: '',
        popupNodeId: '',
        labelNodeId: '',
        valueNodeId: '',
        optionNodeIds: [],
    });
    const ref = buildControlRef('test', 'root');
    controlIndex[ref] = comp;

    const nRoot = makeNode('root', 'generic');
    const tree: UnifiedNode = { id: 'top', role: 'root', children: [nRoot] };

    attachControlRefsToNodes(tree, controlIndex);
    assert.deepStrictEqual(nRoot.control, { kind: 'test', ref });
});

test('controlIndex integrated with buildSnapshot pipeline', () => {
    const registry = createControlRegistry();
    const comp = makeComponent({ id: 's1', kind: 'native_select', rootNodeId: 'select1' });
    registerControlCollector(registry, () => [comp]);

    const selectNode = makeNode('select1', 'generic');
    const root = makeNode('root', 'root', [selectNode]);
    const nodeIndex: Record<string, UnifiedNode> = { root, select1: selectNode };

    const controlIndex = collectControlComponents(root, nodeIndex, registry);
    assert.strictEqual(Object.keys(controlIndex).length, 1);
    const ref = buildControlRef('native_select', 'select1');
    assert.ok(controlIndex[ref]);

    attachControlRefsToNodes(root, controlIndex);
    assert.deepStrictEqual(nodeIndex['select1'].control, { kind: 'native_select', ref });
});

test('controlIndex entries preserve options and state in data', () => {
    const registry = createControlRegistry();
    const comp = makeComponent({
        id: 's1',
        kind: 'native_select',
        rootNodeId: 'select1',
        optionNodeIds: ['opt1', 'opt2'],
        state: { expanded: false, multiple: true, disabled: false, readonly: false, focused: true },
        data: {
            options: [
                { value: 'v1', label: 'Option 1', selected: true, nodeId: 'opt1' },
                { value: 'v2', label: 'Option 2', selected: false, nodeId: 'opt2' },
            ],
            selectedValues: ['v1'],
            selectedLabels: ['Option 1'],
            optionMatchHints: ['Option 1', 'Option 2'],
        },
    });
    registerControlCollector(registry, () => [comp]);

    const root = makeNode('root', 'root');
    const nodeIndex: Record<string, UnifiedNode> = { root, select1: makeNode('select1', 'generic') };

    const controlIndex = collectControlComponents(root, nodeIndex, registry);
    const ref = buildControlRef('native_select', 'select1');
    const entry = controlIndex[ref];

    assert.ok(entry);
    assert.strictEqual(entry.state.multiple, true);
    assert.strictEqual(entry.state.focused, true);
    assert.strictEqual(entry.state.expanded, false);

    const opts = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(opts.length, 2);
    assert.strictEqual(opts[0].selected, true);
    assert.strictEqual(opts[1].selected, false);

    const selValues = entry.data.selectedValues as string[];
    assert.deepStrictEqual(selValues, ['v1']);

    const selLabels = entry.data.selectedLabels as string[];
    assert.deepStrictEqual(selLabels, ['Option 1']);
});
