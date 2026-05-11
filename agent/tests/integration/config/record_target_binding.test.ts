import test from 'node:test';
import assert from 'node:assert/strict';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';
import {
    attachControlRefsToNodes,
    collectControlComponents,
    createControlRegistry,
} from '../../src/runner/steps/executors/snapshot/control';
import { registerSelectOptionControls } from '../../src/runner/steps/executors/select_option/register_controls';
import type { ControlCollectContext } from '../../src/runner/steps/executors/snapshot/control/types';
import {
    findControlByNodeId,
    readControlOptionByNodeId,
    readOptionRecordedValue,
    readSelectedValuesFromControl,
    resolveRecordTargetBinding,
    setRecordTargetSnapshotResolverForTest,
} from '../../src/record/pipeline/target_binding';

const node = (id: string, controlRef?: string): UnifiedNode => ({
    id,
    role: 'generic',
    children: [],
    ...(controlRef ? { control: { kind: 'x', ref: controlRef } } : {}),
});

const makeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const buildNodeIndex = (root: UnifiedNode): Record<string, UnifiedNode> => {
    const index: Record<string, UnifiedNode> = {};
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const current = stack.pop()!;
        index[current.id] = current;
        for (const child of current.children) {
            stack.push(child);
        }
    }
    return index;
};

const setAttr = (ctx: ControlCollectContext, nodeId: string, key: string, value: string): void => {
    if (!ctx.attrIndex[nodeId]) {ctx.attrIndex[nodeId] = {};}
    ctx.attrIndex[nodeId][key] = value;
};

const buildLegacyAntSnapshot = (): SnapshotResult => {
    const item1 = makeNode('legacy_item_1', 'option'); item1.name = 'A：系统自动化';
    const item2 = makeNode('legacy_item_2', 'option'); item2.name = 'B：人工操作，经常出错';
    const menu = makeNode('legacy_menu', 'menu', [item1, item2]);
    const dropdown = makeNode('legacy_dropdown', 'generic', [menu]);
    const rendered = makeNode('legacy_rendered', 'generic'); rendered.name = '你喜欢什么样的工作方式？';
    const trigger = makeNode('legacy_trigger', 'combobox', [rendered]);
    const rootSelect = makeNode('legacy_root', 'generic', [trigger]);
    const root = makeNode('root', 'root', [rootSelect, dropdown]);

    const ctx: ControlCollectContext = {
        root,
        nodeIndex: buildNodeIndex(root),
        attrIndex: {},
        contentStore: {},
        locatorIndex: {},
    };

    setAttr(ctx, 'legacy_root', 'class', 'ant-select ant-select-enabled');
    setAttr(ctx, 'legacy_trigger', 'class', 'ant-select-selection ant-select-selection--single');
    setAttr(ctx, 'legacy_rendered', 'class', 'ant-select-selection__rendered');
    setAttr(ctx, 'legacy_dropdown', 'class', 'ant-select-dropdown');
    setAttr(ctx, 'legacy_menu', 'class', 'ant-select-dropdown-menu');
    setAttr(ctx, 'legacy_item_1', 'class', 'ant-select-dropdown-menu-item');
    setAttr(ctx, 'legacy_item_1', 'value', 'A：系统自动化');
    setAttr(ctx, 'legacy_item_2', 'class', 'ant-select-dropdown-menu-item ant-select-dropdown-menu-item-active');
    setAttr(ctx, 'legacy_item_2', 'value', 'B：人工操作，经常出错');

    const registry = createControlRegistry();
    registerSelectOptionControls(registry);
    const controlIndex = collectControlComponents(ctx, registry);
    attachControlRefsToNodes(root, controlIndex);

    return {
        root,
        nodeIndex: ctx.nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {
            legacy_trigger: {
                origin: { primaryDomId: 'd-trigger' },
                direct: { kind: 'css', query: 'div.ant-select.ant-select-enabled > div.ant-select-selection', source: 'test' },
            },
            legacy_item_2: {
                origin: { primaryDomId: 'd-opt2' },
                direct: { kind: 'css', query: 'div > ul.ant-select-dropdown-menu > li:nth-of-type(2)', source: 'test' },
            },
        },
        bboxIndex: {},
        attrIndex: ctx.attrIndex,
        contentStore: {},
        controlIndex,
    };
};

const makeSnapshot = (): SnapshotResult => ({
    root: node('root'),
    nodeIndex: {
        root: node('root'),
        n1: node('n1'),
        opt1: node('opt1'),
    },
    entityIndex: { entities: {}, byNodeId: {} },
    locatorIndex: {
        n1: { origin: { primaryDomId: 'd1' }, direct: { kind: 'css', query: '#a', source: 'test' } },
    },
    bboxIndex: {},
    attrIndex: { n1: {}, opt1: {} },
    contentStore: {},
    controlIndex: {
        ref1: {
            id: 'c1',
            kind: 'checkbox_group',
            owner: 'browser.select_option',
            capabilities: ['select_option'],
            source: 'test',
            confidence: 1,
            rootNodeId: 'n1',
            optionNodeIds: ['opt1'],
            state: { expanded: false, multiple: true, disabled: false, readonly: false, focused: false },
            data: { options: [
                { nodeId: 'opt1', value: 'A', selected: true },
                { nodeId: 'opt2', label: 'B', selected: true },
            ] },
        },
    },
});

test('findControlByNodeId resolves via optionNodeIds', () => {
    const snapshot = makeSnapshot();
    const found = findControlByNodeId(snapshot, 'opt1');
    assert.equal(found?.controlRef, 'ref1');
    assert.equal(found?.componentKind, 'checkbox_group');
});

test('option value reading and selected values keep option order', () => {
    const snapshot = makeSnapshot();
    const comp = snapshot.controlIndex.ref1;
    const option = readControlOptionByNodeId(comp, 'opt1');
    assert.equal(readOptionRecordedValue(option || {}), 'A');
    assert.deepEqual(readSelectedValuesFromControl(comp), ['A', 'B']);
});

test('resolveRecordTargetBinding unique match returns binding', async () => {
    const snapshot = makeSnapshot();
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const binding = await resolveRecordTargetBinding({
        event: { tabName: 'tab-a', ts: 1, type: 'click', selector: '#a' },
        snapshotCache: new Map(),
        cacheKey: 'k',
    });
    assert.equal(binding?.targetNodeId, 'n1');
    assert.equal(binding?.componentKind, 'checkbox_group');
    setRecordTargetSnapshotResolverForTest(null);
});

test('resolveRecordTargetBinding ambiguous selector returns undefined', async () => {
    const snapshot = makeSnapshot();
    snapshot.locatorIndex.n2 = snapshot.locatorIndex.n1;
    snapshot.nodeIndex.n2 = node('n2');
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const binding = await resolveRecordTargetBinding({
        event: { tabName: 'tab-a', ts: 1, type: 'click', selector: '#a' },
        snapshotCache: new Map(),
        cacheKey: 'k',
    });
    assert.equal(binding, undefined);
    setRecordTargetSnapshotResolverForTest(null);
});

test('resolveRecordTargetBinding can match by locatorCandidates role name', async () => {
    const snapshot = makeSnapshot();
    snapshot.nodeIndex.opt1 = {
        ...snapshot.nodeIndex.opt1,
        role: 'checkbox',
        name: 'blue',
    };
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const binding = await resolveRecordTargetBinding({
        event: {
            tabName: 'tab-a',
            ts: 1,
            type: 'check',
            selector: 'div.long.css > input',
            locatorCandidates: [{ kind: 'role', role: 'checkbox', name: 'blue', exact: true }],
        },
        snapshotCache: new Map(),
        cacheKey: 'k',
    });
    assert.equal(binding?.targetNodeId, 'opt1');
    assert.equal(binding?.componentKind, 'checkbox_group');
    setRecordTargetSnapshotResolverForTest(null);
});

test('legacy ant select trigger and option bind to custom_select control', async () => {
    const snapshot = buildLegacyAntSnapshot();
    setRecordTargetSnapshotResolverForTest(async () => snapshot);

    const triggerBinding = await resolveRecordTargetBinding({
        event: {
            tabName: 'tab-a',
            ts: 1,
            type: 'click',
            selector: 'div.ant-select.ant-select-enabled > div.ant-select-selection',
        },
        snapshotCache: new Map(),
        cacheKey: 'legacy-ant',
    });
    assert.ok(triggerBinding);
    assert.equal(triggerBinding?.componentKind, 'custom_select');
    assert.equal(triggerBinding?.targetNodeId, 'legacy_trigger');
    assert.equal(triggerBinding?.controlRootNodeId, 'legacy_root');

    const optionBinding = await resolveRecordTargetBinding({
        event: {
            tabName: 'tab-a',
            ts: 2,
            type: 'click',
            selector: 'div > ul.ant-select-dropdown-menu > li:nth-of-type(2)',
            a11yHint: { role: 'option', name: 'B：人工操作，经常出错' },
            locatorCandidates: [
                { kind: 'role', role: 'option', name: 'B：人工操作，经常出错', exact: true },
                { kind: 'text', text: 'B：人工操作，经常出错', exact: true },
            ],
        },
        snapshotCache: new Map(),
        cacheKey: 'legacy-ant',
    });
    assert.ok(optionBinding);
    assert.equal(optionBinding?.componentKind, 'custom_select');
    assert.equal(optionBinding?.targetNodeId, 'legacy_item_2');
    assert.equal(optionBinding?.controlRootNodeId, 'legacy_root');
    assert.equal(snapshot.controlIndex[optionBinding!.controlRef].optionNodeIds.includes(optionBinding!.targetNodeId), true);

    setRecordTargetSnapshotResolverForTest(null);
});
