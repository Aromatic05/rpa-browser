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
    ControlCollectContext,
    BaseControlComponent,
} from '../../../src/runner/steps/executors/snapshot/control/types';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const makeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const makeCtx = (overrides: Partial<ControlCollectContext> = {}): ControlCollectContext => ({
    root: makeNode('root', 'root'),
    nodeIndex: {},
    attrIndex: {},
    contentStore: {},
    locatorIndex: {},
    ...overrides,
});

const makeComponent = (overrides: Partial<BaseControlComponent> = {}): BaseControlComponent => ({
    id: 'c1',
    kind: 'test_kind',
    owner: 'test.owner',
    capabilities: ['test_cap'],
    source: 'auto',
    confidence: 1,
    rootNodeId: 'n1',
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
    registerControlCollector(registry, (_ctx) => [comp1]);
    registerControlCollector(registry, (_ctx) => [comp2]);

    const ctx = makeCtx({
        nodeIndex: { r1: makeNode('r1', 'generic'), r2: makeNode('r2', 'generic') },
    });

    const controlIndex = collectControlComponents(ctx, registry);
    assert.strictEqual(Object.keys(controlIndex).length, 2);
    const ref1 = buildControlRef('k1', 'r1');
    const ref2 = buildControlRef('k2', 'r2');
    assert.ok(controlIndex[ref1]);
    assert.ok(controlIndex[ref2]);
    assert.strictEqual(controlIndex[ref1].id, 'a');
    assert.strictEqual(controlIndex[ref2].id, 'b');
});

test('collectControlComponents throws on duplicate ref', () => {
    const registry = createControlRegistry();
    const comp1 = makeComponent({ id: 'first', kind: 'k', rootNodeId: 'r', owner: 'owner1' });
    const comp2 = makeComponent({ id: 'second', kind: 'k', rootNodeId: 'r', owner: 'owner2' });
    registerControlCollector(registry, (_ctx) => [comp1]);
    registerControlCollector(registry, (_ctx) => [comp2]);

    const ctx = makeCtx({
        nodeIndex: { r: makeNode('r', 'generic') },
    });

    assert.throws(
        () => collectControlComponents(ctx, registry),
        /duplicate control ref/,
    );
});

test('collectControlComponents throws with ref, kind, rootNodeId, owner in message', () => {
    const registry = createControlRegistry();
    const comp1 = makeComponent({ id: 'c1', kind: 'native_select', rootNodeId: 'n42', owner: 'browser.select_option' });
    const comp2 = makeComponent({ id: 'c2', kind: 'native_select', rootNodeId: 'n42', owner: 'other.owner' });
    registerControlCollector(registry, (_ctx) => [comp1]);
    registerControlCollector(registry, (_ctx) => [comp2]);

    const ctx = makeCtx({ nodeIndex: { n42: makeNode('n42', 'generic') } });

    assert.throws(
        () => collectControlComponents(ctx, registry),
        (err: Error) => {
            const msg = err.message;
            return msg.includes('control:native_select:n42')
                && msg.includes('native_select')
                && msg.includes('n42')
                && msg.includes('browser.select_option')
                && msg.includes('other.owner');
        },
    );
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
        optionNodeIds: ['opt1', 'opt2'],
    });
    const ref = buildControlRef('test', 'root');
    controlIndex[ref] = comp;

    const nRoot = makeNode('root', 'generic');
    const nCtrl = makeNode('ctrl', 'generic');
    const nOpt1 = makeNode('opt1', 'generic');
    const nOpt2 = makeNode('opt2', 'generic');
    const nOther = makeNode('other', 'generic');

    const tree: UnifiedNode = {
        id: 'top',
        role: 'root',
        children: [nRoot, nCtrl, nOpt1, nOpt2, nOther],
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

test('attachControlRefsToNodes handles missing optional nodeId fields', () => {
    const controlIndex: Record<string, BaseControlComponent> = {};
    const comp = makeComponent({
        id: 'c1',
        kind: 'test',
        rootNodeId: 'root',
        controlNodeId: undefined,
        triggerNodeId: undefined,
        popupNodeId: undefined,
        labelNodeId: undefined,
        valueNodeId: undefined,
        optionNodeIds: [],
    });
    const ref = buildControlRef('test', 'root');
    controlIndex[ref] = comp;

    const nRoot = makeNode('root', 'generic');
    const tree: UnifiedNode = { id: 'top', role: 'root', children: [nRoot] };

    attachControlRefsToNodes(tree, controlIndex);
    assert.deepStrictEqual(nRoot.control, { kind: 'test', ref });
    assert.strictEqual(nRoot.control.kind, 'test');
    assert.strictEqual(nRoot.control.ref, ref);
});

test('controlIndex is stable empty object when no collectors registered', () => {
    const registry = createControlRegistry();
    const ctx = makeCtx({ root: makeNode('r', 'root') });
    const controlIndex = collectControlComponents(ctx, registry);
    assert.deepStrictEqual(controlIndex, {});
    assert.strictEqual(Object.keys(controlIndex).length, 0);
});

test('collector receives ControlCollectContext with all indexes', () => {
    const registry = createControlRegistry();
    let receivedCtx: ControlCollectContext | undefined;

    registerControlCollector(registry, (ctx) => {
        receivedCtx = ctx;
        return [];
    });

    const attrIndex = { n1: { id: 'my-id', tag: 'select' } };
    const contentStore = { content_n1: 'hello' };
    const locatorIndex = { n1: { origin: { primaryDomId: '100' } } };
    const ctx = makeCtx({ attrIndex, contentStore, locatorIndex });

    collectControlComponents(ctx, registry);
    assert.ok(receivedCtx);
    assert.strictEqual(receivedCtx.attrIndex, attrIndex);
    assert.strictEqual(receivedCtx.contentStore, contentStore);
    assert.strictEqual(receivedCtx.locatorIndex, locatorIndex);
});
