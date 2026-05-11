import test from 'node:test';
import assert from 'node:assert/strict';
import {
    appendWorkspaceRecordingEvent,
    createRecordingState,
    enableWorkspaceRecording,
    getWorkspaceUnsavedRecordingBundle,
    resetWorkspaceUnsavedRecording,
} from '../../src/record/recording';
import { resolveRecordTargetBinding, setRecordTargetSnapshotResolverForTest } from '../../src/record/pipeline/target_binding';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';
import {
    attachControlRefsToNodes,
    collectControlComponents,
    createControlRegistry,
} from '../../src/runner/steps/executors/snapshot/control';
import { registerSelectOptionControls } from '../../src/runner/steps/executors/select_option/register_controls';
import type { ControlCollectContext } from '../../src/runner/steps/executors/snapshot/control/types';

const node = (id: string, role = 'generic', controlRef?: string): UnifiedNode => ({
    id,
    role,
    children: [],
    ...(controlRef ? { control: { kind: 'x', ref: controlRef } } : {}),
});

const treeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const baseState = () => {
    const state = createRecordingState();
    resetWorkspaceUnsavedRecording(state, 'ws-1');
    enableWorkspaceRecording(state, 'ws-1');
    return state;
};

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
    const item1 = treeNode('legacy_item_1', 'option'); item1.name = 'A：系统自动化';
    const item2 = treeNode('legacy_item_2', 'option'); item2.name = 'B：人工操作，经常出错';
    const item3 = treeNode('legacy_item_3', 'option'); item3.name = 'C：手动处理，加班无限';
    const menu = treeNode('legacy_menu', 'menu', [item1, item2, item3]);
    const dropdown = treeNode('legacy_dropdown', 'generic', [menu]);
    const rendered = treeNode('legacy_rendered', 'generic'); rendered.name = '你喜欢什么样的工作方式？';
    const trigger = treeNode('legacy_trigger', 'combobox', [rendered]);
    trigger.name = '你喜欢什么样的工作方式？';
    const rootSelect = treeNode('legacy_root', 'generic', [trigger]);
    const root = treeNode('root', 'root', [rootSelect, dropdown]);
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
    setAttr(ctx, 'legacy_item_2', 'class', 'ant-select-dropdown-menu-item ant-select-dropdown-menu-item-active');
    setAttr(ctx, 'legacy_item_3', 'class', 'ant-select-dropdown-menu-item');

    const registry = createControlRegistry();
    registerSelectOptionControls(registry);
    const controlIndex = collectControlComponents(ctx, registry);
    attachControlRefsToNodes(root, controlIndex);
    const customEntries = Object.values(controlIndex).filter((item) => item.kind === 'custom_select');
    assert.equal(customEntries.length, 1);
    assert.ok(ctx.nodeIndex.legacy_trigger.control?.ref);

    return {
        root,
        nodeIndex: ctx.nodeIndex,
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {
            legacy_trigger: {
                origin: { primaryDomId: 'dom-trigger' },
                direct: {
                    kind: 'css',
                    query: 'div.ant-col.ant-col-12:nth-of-type(2) > div.ant-row.ant-form-item > div.ant-col.ant-col-16:nth-of-type(2) > div.ant-form-item-control > span.ant-form-item-children > div.ant-select.ant-select-enabled > div.ant-select-selection',
                    source: 'test',
                },
            },
            legacy_item_3: {
                origin: { primaryDomId: 'dom-opt3' },
                direct: {
                    kind: 'css',
                    query: 'div > ul.ant-select-dropdown-menu > li:nth-of-type(3)',
                    source: 'test',
                },
            },
        },
        bboxIndex: {},
        attrIndex: ctx.attrIndex,
        contentStore: {},
        controlIndex,
    };
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

test('legacy ant select recording merges trigger and option into one custom_select step', async () => {
    const state = baseState();
    const snapshot = buildLegacyAntSnapshot();
    setRecordTargetSnapshotResolverForTest(async () => snapshot);

    const triggerSelector = 'div.ant-col.ant-col-12:nth-of-type(2) > div.ant-row.ant-form-item > div.ant-col.ant-col-16:nth-of-type(2) > div.ant-form-item-control > span.ant-form-item-children > div.ant-select.ant-select-enabled > div.ant-select-selection';
    const optionSelector = 'div > ul.ant-select-dropdown-menu > li:nth-of-type(3)';
    const triggerBinding = await resolveRecordTargetBinding({
        event: {
            tabName: 'tab-a',
            ts: 129,
            type: 'click',
            selector: triggerSelector,
            a11yHint: { role: 'combobox', name: '你喜欢什么样的工作方式？' },
        } as any,
        snapshotCache: new Map(),
        cacheKey: 'legacy-merge',
        forceFreshSnapshot: true,
    });
    assert.ok(triggerBinding);
    assert.equal(triggerBinding?.componentKind, 'custom_select');

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 130, type: 'click', selector: triggerSelector,
        a11yHint: { role: 'combobox', name: '你喜欢什么样的工作方式？' },
    } as any, 1200);
    const afterTrigger = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(afterTrigger.length, 0);

    // Fresh snapshot on option-click may not include option node; return trigger-only snapshot to exercise semantic consume.
    const triggerOnly = buildLegacyAntSnapshot();
    delete triggerOnly.locatorIndex.legacy_item_3;
    delete triggerOnly.nodeIndex.legacy_item_3;
    delete triggerOnly.attrIndex.legacy_item_3;
    for (const component of Object.values(triggerOnly.controlIndex)) {
        if (component.kind === 'custom_select') {
            component.optionNodeIds = [];
            component.data.options = [];
        }
    }
    setRecordTargetSnapshotResolverForTest(async () => triggerOnly);

    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 131, type: 'click', selector: optionSelector,
        a11yHint: { role: 'option', name: 'C：手动处理，加班无限' },
        locatorCandidates: [
            { kind: 'role', role: 'option', name: 'C：手动处理，加班无限', exact: true },
            { kind: 'text', text: 'C：手动处理，加班无限', exact: true },
        ],
    } as any, 1200);

    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.select_option');
    assert.equal((steps[0].args as any).kind, 'custom_select');
    assert.deepEqual((steps[0].args as any).values, ['C：手动处理，加班无限']);
    assert.equal((steps[0].args as any).selector, triggerSelector);
    setRecordTargetSnapshotResolverForTest(null);
});

test('role=option click does not generate select_option without pending custom session', async () => {
    const state = baseState();
    setRecordTargetSnapshotResolverForTest(async () => undefined);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 150, type: 'click', selector: 'div > ul.ant-select-dropdown-menu > li:nth-of-type(3)',
        a11yHint: { role: 'option', name: 'C：手动处理，加班无限' },
        locatorCandidates: [{ kind: 'role', role: 'option', name: 'C：手动处理，加班无限', exact: true }],
    } as any, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.length, 1);
    assert.equal(steps[0].name, 'browser.click');
    setRecordTargetSnapshotResolverForTest(null);
});

test('role=option click with pending custom session but non-ant selector does not generate select_option', async () => {
    const state = baseState();
    const snapshot = buildLegacyAntSnapshot();
    setRecordTargetSnapshotResolverForTest(async () => snapshot);
    const triggerSelector = 'div.ant-col.ant-col-12:nth-of-type(2) > div.ant-row.ant-form-item > div.ant-col.ant-col-16:nth-of-type(2) > div.ant-form-item-control > span.ant-form-item-children > div.ant-select.ant-select-enabled > div.ant-select-selection';
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 170, type: 'click', selector: triggerSelector,
        a11yHint: { role: 'combobox', name: '你喜欢什么样的工作方式？' },
    } as any, 1200);
    await appendWorkspaceRecordingEvent(state, 'ws-1', 'tab-a', {
        tabName: 'tab-a', ts: 171, type: 'click', selector: 'ul.menu > li.item',
        a11yHint: { role: 'option', name: 'C：手动处理，加班无限' },
        locatorCandidates: [{ kind: 'role', role: 'option', name: 'C：手动处理，加班无限', exact: true }],
    } as any, 1200);
    const steps = getWorkspaceUnsavedRecordingBundle(state, 'ws-1').steps;
    assert.equal(steps.some((step) => step.name === 'browser.select_option'), false);
    setRecordTargetSnapshotResolverForTest(null);
});
