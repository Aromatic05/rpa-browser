import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createControlRegistry,
    collectControlComponents,
    attachControlRefsToNodes,
    buildControlRef,
    buildDomIdToNodeIdMap,
} from '../../../src/runner/steps/executors/snapshot/control';
import type { ControlCollectContext } from '../../../src/runner/steps/executors/snapshot/control/types';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { registerSelectOptionControls } from '../../../src/runner/steps/executors/select_option/register_controls';

const makeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const buildNodeIndex = (root: UnifiedNode): Record<string, UnifiedNode> => {
    const index: Record<string, UnifiedNode> = {};
    const stack: UnifiedNode[] = [root];
    while (stack.length > 0) {
        const node = stack.pop()!;
        index[node.id] = node;
        for (const child of node.children) {
            stack.push(child);
        }
    }
    return index;
};

const makeCtx = (root: UnifiedNode, overrides: Partial<ControlCollectContext> = {}): ControlCollectContext => ({
    root,
    nodeIndex: buildNodeIndex(root),
    attrIndex: {},
    contentStore: {},
    locatorIndex: {},
    ...overrides,
});

/** Set an attr key=value on node in ctx.attrIndex */
const setAttr = (ctx: ControlCollectContext, nodeId: string, key: string, value: string) => {
    if (!ctx.attrIndex[nodeId]) {ctx.attrIndex[nodeId] = {};}
    ctx.attrIndex[nodeId][key] = value;
};

const setupCtx = (root: UnifiedNode): ControlCollectContext => {
    const ctx = makeCtx(root);
    // Walk all nodes and set tag from a synthetic attr to match how pipeline works
    return ctx;
};

const collect = (root: UnifiedNode, extraCtx?: Partial<ControlCollectContext>) => {
    const ctx = makeCtx(root, extraCtx);
    const registry = createControlRegistry();
    registerSelectOptionControls(registry);
    const controlIndex = collectControlComponents(ctx, registry);
    attachControlRefsToNodes(root, controlIndex);
    return { controlIndex, ctx };
};

// ── native_select ──────────────────────────────────────────────

test('native_select collector detects tag=select element', () => {
    const option1 = makeNode('opt1', 'option');
    option1.name = 'Option One';
    const option2 = makeNode('opt2', 'option');
    option2.name = 'Option Two';

    const select = makeNode('sel', 'generic', [option1, option2]);
    const root = makeNode('root', 'root', [select]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'sel', 'tag', 'select');
    setAttr(ctx, 'opt1', 'tag', 'option');
    setAttr(ctx, 'opt1', 'value', 'val1');
    setAttr(ctx, 'opt1', 'selected', 'true');
    setAttr(ctx, 'opt2', 'tag', 'option');
    setAttr(ctx, 'opt2', 'value', 'val2');

    const { controlIndex } = collect(root, ctx);

    const ref = buildControlRef('native_select', 'sel');
    assert.ok(controlIndex[ref], 'controlIndex should have native_select entry');
    assert.strictEqual(controlIndex[ref].kind, 'native_select');
    assert.strictEqual(controlIndex[ref].owner, 'browser.select_option');
    assert.ok(controlIndex[ref].capabilities.includes('select_option'));
    assert.strictEqual(controlIndex[ref].rootNodeId, 'sel');
    assert.strictEqual(controlIndex[ref].controlNodeId, 'sel');
    assert.strictEqual(controlIndex[ref].triggerNodeId, undefined);
    assert.strictEqual(controlIndex[ref].popupNodeId, undefined);

    const options = controlIndex[ref].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].value, 'val1');
    assert.strictEqual(options[0].label, 'Option One');
    assert.strictEqual(options[0].selected, true);
    assert.strictEqual(options[1].selected, false);
    assert.strictEqual(controlIndex[ref].state.multiple, false);

    // role preserved
    assert.strictEqual(ctx.nodeIndex['sel'].role, 'generic');
    assert.strictEqual(ctx.nodeIndex['opt1'].role, 'option');

    // control.ref shared
    const selectNode = ctx.nodeIndex['sel'];
    assert.ok(selectNode.control);
    assert.strictEqual(selectNode.control!.ref, ref);
    const optNode = ctx.nodeIndex['opt1'];
    assert.ok(optNode.control);
    assert.strictEqual(optNode.control!.ref, ref);
});

// ── radio_group ────────────────────────────────────────────────

test('radio_group collector aggregates same-name same-container input[type=radio]', () => {
    const radio1 = makeNode('r1', 'radio');
    radio1.name = 'Red';
    const radio2 = makeNode('r2', 'radio');
    radio2.name = 'Blue';
    const radio3 = makeNode('r3', 'radio');
    radio3.name = 'Small';

    const container = makeNode('container', 'group', [radio1, radio2, radio3]);
    const root = makeNode('root', 'root', [container]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'r1', 'tag', 'input'); setAttr(ctx, 'r1', 'type', 'radio'); setAttr(ctx, 'r1', 'name', 'color'); setAttr(ctx, 'r1', 'value', 'red'); setAttr(ctx, 'r1', 'checked', 'true');
    setAttr(ctx, 'r2', 'tag', 'input'); setAttr(ctx, 'r2', 'type', 'radio'); setAttr(ctx, 'r2', 'name', 'color'); setAttr(ctx, 'r2', 'value', 'blue');
    setAttr(ctx, 'r3', 'tag', 'input'); setAttr(ctx, 'r3', 'type', 'radio'); setAttr(ctx, 'r3', 'name', 'size'); setAttr(ctx, 'r3', 'value', 'small');
    setAttr(ctx, 'container', 'role', 'group');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 1, 'should create one radio_group for color group');

    const entry = entries[0];
    assert.strictEqual(entry.kind, 'radio_group');
    assert.strictEqual(entry.owner, 'browser.select_option');
    assert.strictEqual(entry.state.multiple, false);

    const options = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    const selectedOpt = options.find((o) => o.selected) as Record<string, unknown>;
    assert.ok(selectedOpt);
    assert.strictEqual(selectedOpt.value, 'red');

    // role preserved
    assert.strictEqual(ctx.nodeIndex['r1'].role, 'radio');
    // lone radio (size) should have no control
    assert.strictEqual(ctx.nodeIndex['r3'].control, undefined);
});

test('radio_group does not merge same-name radios across different containers', () => {
    const r1 = makeNode('ra1', 'radio'); r1.name = 'Yes';
    const r2 = makeNode('ra2', 'radio'); r2.name = 'No';
    const r3 = makeNode('rb1', 'radio'); r3.name = 'Yes';
    const r4 = makeNode('rb2', 'radio'); r4.name = 'No';

    const containerA = makeNode('ca', 'form', [r1, r2]);
    const containerB = makeNode('cb', 'form', [r3, r4]);
    const root = makeNode('root', 'root', [containerA, containerB]);

    const ctx = makeCtx(root);
    for (const [id, name, value] of [['ra1', 'yesno', 'yes'], ['ra2', 'yesno', 'no'], ['rb1', 'yesno', 'yes'], ['rb2', 'yesno', 'no']] as const) {
        setAttr(ctx, id, 'tag', 'input'); setAttr(ctx, id, 'type', 'radio'); setAttr(ctx, id, 'name', name); setAttr(ctx, id, 'value', value);
    }
    setAttr(ctx, 'ca', 'role', 'form');
    setAttr(ctx, 'cb', 'role', 'form');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 2, 'should create two separate radio_groups, one per container');

    // Each group should have 2 options
    for (const entry of entries) {
        const options = entry.data.options as Array<Record<string, unknown>>;
        assert.strictEqual(options.length, 2);
    }
});

// ── Ant Radio Group ──────────────────────────────────────

test('Ant Radio Group with ant-radio-group class aggregates correctly', () => {
    const r1 = makeNode('ar1', 'radio'); r1.name = 'A';
    const r2 = makeNode('ar2', 'radio'); r2.name = 'B';

    const wrapper = makeNode('ant_radio_wrapper', 'generic', [r1, r2]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ar1', 'tag', 'input'); setAttr(ctx, 'ar1', 'type', 'radio'); setAttr(ctx, 'ar1', 'name', 'ant_option'); setAttr(ctx, 'ar1', 'value', 'a'); setAttr(ctx, 'ar1', 'checked', 'true');
    setAttr(ctx, 'ar2', 'tag', 'input'); setAttr(ctx, 'ar2', 'type', 'radio'); setAttr(ctx, 'ar2', 'name', 'ant_option'); setAttr(ctx, 'ar2', 'value', 'b');
    setAttr(ctx, 'ant_radio_wrapper', 'class', 'ant-radio-group ant-radio-group-outline');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].state.multiple, false);

    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
});

test('radio_group does not merge same-name across different form-item containers', () => {
    const r1 = makeNode('rf1a', 'radio'); r1.name = 'A';
    const r2 = makeNode('rf1b', 'radio'); r2.name = 'B';
    const r3 = makeNode('rf2a', 'radio'); r3.name = 'A';
    const r4 = makeNode('rf2b', 'radio'); r4.name = 'B';

    const formItem1 = makeNode('rfi1', 'generic', [r1, r2]);
    const formItem2 = makeNode('rfi2', 'generic', [r3, r4]);
    const root = makeNode('root', 'root', [formItem1, formItem2]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'rf1a', 'tag', 'input'); setAttr(ctx, 'rf1a', 'type', 'radio'); setAttr(ctx, 'rf1a', 'name', 'group_x'); setAttr(ctx, 'rf1a', 'value', 'a');
    setAttr(ctx, 'rf1b', 'tag', 'input'); setAttr(ctx, 'rf1b', 'type', 'radio'); setAttr(ctx, 'rf1b', 'name', 'group_x'); setAttr(ctx, 'rf1b', 'value', 'b');
    setAttr(ctx, 'rf2a', 'tag', 'input'); setAttr(ctx, 'rf2a', 'type', 'radio'); setAttr(ctx, 'rf2a', 'name', 'group_x'); setAttr(ctx, 'rf2a', 'value', 'a');
    setAttr(ctx, 'rf2b', 'tag', 'input'); setAttr(ctx, 'rf2b', 'type', 'radio'); setAttr(ctx, 'rf2b', 'name', 'group_x'); setAttr(ctx, 'rf2b', 'value', 'b');
    setAttr(ctx, 'rfi1', 'class', 'form-item');
    setAttr(ctx, 'rfi2', 'class', 'form-item');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 2, 'each form-item should produce its own radio_group');
});

test('single radio does not generate radio_group', () => {
    const r1 = makeNode('sr1', 'radio'); r1.name = 'Only';
    const container = makeNode('src', 'group', [r1]);
    const root = makeNode('root', 'root', [container]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'sr1', 'tag', 'input'); setAttr(ctx, 'sr1', 'type', 'radio'); setAttr(ctx, 'sr1', 'name', 'single'); setAttr(ctx, 'sr1', 'value', 'only');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 0);
});

test('Ant Radio nested structure within ant-radio-group aggregates correctly', () => {
    const r1 = makeNode('anr1', 'radio'); r1.name = 'Yes';
    const r2 = makeNode('anr2', 'radio'); r2.name = 'No';

    const label1 = makeNode('anl1', 'generic', [r1]);
    const label2 = makeNode('anl2', 'generic', [r2]);
    const radioGroup = makeNode('anrg', 'generic', [label1, label2]);
    const root = makeNode('root', 'root', [radioGroup]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'anr1', 'tag', 'input'); setAttr(ctx, 'anr1', 'type', 'radio'); setAttr(ctx, 'anr1', 'name', 'ant_yn'); setAttr(ctx, 'anr1', 'value', 'yes'); setAttr(ctx, 'anr1', 'checked', 'true');
    setAttr(ctx, 'anr2', 'tag', 'input'); setAttr(ctx, 'anr2', 'type', 'radio'); setAttr(ctx, 'anr2', 'name', 'ant_yn'); setAttr(ctx, 'anr2', 'value', 'no');
    setAttr(ctx, 'anrg', 'class', 'ant-radio-group ant-radio-group-outline');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 1);
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
});

// ── checkbox_group ────────────────────────────────────────────

test('checkbox_group detects explicit group container by role=group', () => {
    const cb1 = makeNode('cb1', 'checkbox'); cb1.name = 'Apple';
    const cb2 = makeNode('cb2', 'checkbox'); cb2.name = 'Banana';

    const group = makeNode('cb_group', 'group', [cb1, cb2]);
    const root = makeNode('root', 'root', [group]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'cb1', 'tag', 'input'); setAttr(ctx, 'cb1', 'type', 'checkbox'); setAttr(ctx, 'cb1', 'value', 'apple'); setAttr(ctx, 'cb1', 'checked', 'true');
    setAttr(ctx, 'cb2', 'tag', 'input'); setAttr(ctx, 'cb2', 'type', 'checkbox'); setAttr(ctx, 'cb2', 'value', 'banana');
    setAttr(ctx, 'cb_group', 'role', 'group');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].kind, 'checkbox_group');
    assert.strictEqual(entries[0].state.multiple, true);

    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);

    const selValues = entries[0].data.selectedValues as string[];
    assert.ok(selValues.includes('apple'));

    // role preserved
    assert.strictEqual(ctx.nodeIndex['cb1'].role, 'checkbox');
});

test('Ant Checkbox Group with ant-checkbox-group class aggregates correctly', () => {
    const cb1 = makeNode('acb1', 'checkbox'); cb1.name = 'Option 1';
    const cb2 = makeNode('acb2', 'checkbox'); cb2.name = 'Option 2';
    const cb3 = makeNode('acb3', 'checkbox'); cb3.name = 'Option 3';

    const wrapper = makeNode('ant_cb_wrapper', 'generic', [cb1, cb2, cb3]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'acb1', 'tag', 'input'); setAttr(ctx, 'acb1', 'type', 'checkbox'); setAttr(ctx, 'acb1', 'value', 'opt1'); setAttr(ctx, 'acb1', 'checked', 'true');
    setAttr(ctx, 'acb2', 'tag', 'input'); setAttr(ctx, 'acb2', 'type', 'checkbox'); setAttr(ctx, 'acb2', 'value', 'opt2');
    setAttr(ctx, 'acb3', 'tag', 'input'); setAttr(ctx, 'acb3', 'type', 'checkbox'); setAttr(ctx, 'acb3', 'value', 'opt3'); setAttr(ctx, 'acb3', 'checked', 'true');
    setAttr(ctx, 'ant_cb_wrapper', 'class', 'ant-checkbox-group');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1);

    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 3);
    const selValues = entries[0].data.selectedValues as string[];
    assert.ok(selValues.includes('opt1'));
    assert.ok(selValues.includes('opt3'));
});

test('checkbox_group uses common ancestor when no explicit group', () => {
    const cb1 = makeNode('icb1', 'checkbox'); cb1.name = 'A';
    const cb2 = makeNode('icb2', 'checkbox'); cb2.name = 'B';

    const div = makeNode('div1', 'generic', [cb1, cb2]);
    const root = makeNode('root', 'root', [div]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'icb1', 'tag', 'input'); setAttr(ctx, 'icb1', 'type', 'checkbox'); setAttr(ctx, 'icb1', 'value', 'a');
    setAttr(ctx, 'icb2', 'tag', 'input'); setAttr(ctx, 'icb2', 'type', 'checkbox'); setAttr(ctx, 'icb2', 'value', 'b');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1);
});

test('checkbox_group does not merge across different form-item containers', () => {
    const cb1 = makeNode('ficb1', 'checkbox'); cb1.name = 'A';
    const cb2 = makeNode('ficb2', 'checkbox'); cb2.name = 'B';
    const cb3 = makeNode('ficb3', 'checkbox'); cb3.name = 'C';

    const formItem1 = makeNode('fi1', 'generic', [cb1, cb2]);
    const formItem2 = makeNode('fi2', 'generic', [cb3]);
    const root = makeNode('root', 'root', [formItem1, formItem2]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ficb1', 'tag', 'input'); setAttr(ctx, 'ficb1', 'type', 'checkbox'); setAttr(ctx, 'ficb1', 'value', 'a');
    setAttr(ctx, 'ficb2', 'tag', 'input'); setAttr(ctx, 'ficb2', 'type', 'checkbox'); setAttr(ctx, 'ficb2', 'value', 'b');
    setAttr(ctx, 'ficb3', 'tag', 'input'); setAttr(ctx, 'ficb3', 'type', 'checkbox'); setAttr(ctx, 'ficb3', 'value', 'c');
    setAttr(ctx, 'fi1', 'class', 'form-item');
    setAttr(ctx, 'fi2', 'class', 'form-item');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1, 'only fi1 checkboxes should form a group');
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2, 'fi1 has 2 checkboxes grouped');
});

test('Ant Checkbox real nested structure aggregates within ant-form-item', () => {
    const cb1 = makeNode('arcb1', 'checkbox'); cb1.name = 'Opt 1';
    const cb2 = makeNode('arcb2', 'checkbox'); cb2.name = 'Opt 2';

    const label1 = makeNode('arl1', 'generic', [cb1]);
    const label2 = makeNode('arl2', 'generic', [cb2]);
    const formItem = makeNode('arfi', 'generic', [label1, label2]);
    const root = makeNode('root', 'root', [formItem]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'arcb1', 'tag', 'input'); setAttr(ctx, 'arcb1', 'type', 'checkbox'); setAttr(ctx, 'arcb1', 'value', 'opt1');
    setAttr(ctx, 'arcb2', 'tag', 'input'); setAttr(ctx, 'arcb2', 'type', 'checkbox'); setAttr(ctx, 'arcb2', 'value', 'opt2');
    setAttr(ctx, 'arfi', 'class', 'ant-form-item');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1);
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
});

test('simple container without explicit group still aggregates via safe container fallback', () => {
    const cb1 = makeNode('svcb1', 'checkbox'); cb1.name = 'X';
    const cb2 = makeNode('svcb2', 'checkbox'); cb2.name = 'Y';

    const plainDiv = makeNode('svdiv', 'generic', [cb1, cb2]);
    const root = makeNode('root', 'root', [plainDiv]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'svcb1', 'tag', 'input'); setAttr(ctx, 'svcb1', 'type', 'checkbox'); setAttr(ctx, 'svcb1', 'value', 'x');
    setAttr(ctx, 'svcb2', 'tag', 'input'); setAttr(ctx, 'svcb2', 'type', 'checkbox'); setAttr(ctx, 'svcb2', 'value', 'y');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1);
});

// ── custom_select (aria path) ─────────────────────────────────

test('custom_select collector detects role=combobox with aria-controls via DOM id', () => {
    const option1 = makeNode('cso1', 'option'); option1.name = 'Choice A';
    const option2 = makeNode('cso2', 'option'); option2.name = 'Choice B';

    const listbox = makeNode('lb1', 'listbox', [option1, option2]);
    const combobox = makeNode('combo1', 'combobox');
    combobox.name = 'Select';

    const wrapper = makeNode('wrapper', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'lb1', 'id', 'listbox-dom-id');
    setAttr(ctx, 'combo1', 'aria-controls', 'listbox-dom-id');
    setAttr(ctx, 'combo1', 'aria-expanded', 'true');
    setAttr(ctx, 'cso1', 'value', 'v1'); setAttr(ctx, 'cso1', 'aria-selected', 'true');
    setAttr(ctx, 'cso2', 'value', 'v2');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].kind, 'custom_select');
    assert.strictEqual(entries[0].popupNodeId, 'lb1');
    assert.strictEqual(entries[0].state.expanded, true);

    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].selected, true);

    const ref = buildControlRef('custom_select', 'combo1');
    const comboNode = ctx.nodeIndex['combo1'];
    assert.ok(comboNode.control);
    assert.strictEqual(comboNode.control!.ref, ref);
    assert.strictEqual(comboNode.role, 'combobox');

    const optNode = ctx.nodeIndex['cso1'];
    assert.ok(optNode.control);
    assert.strictEqual(optNode.control!.ref, ref);
});

test('custom_select collector handles aria-owns via DOM id', () => {
    const option1 = makeNode('po1', 'option'); option1.name = 'Item 1';
    const listbox = makeNode('lb_owns', 'listbox', [option1]);
    const combobox = makeNode('combo_owns', 'combobox');
    const wrapper = makeNode('wrapper', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'lb_owns', 'id', 'owns-dom-id');
    setAttr(ctx, 'combo_owns', 'aria-owns', 'owns-dom-id');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].popupNodeId, 'lb_owns');
});

test('custom_select not generated when aria-controls DOM id not found', () => {
    const combobox = makeNode('combo_nf', 'combobox');
    const root = makeNode('root', 'root', [combobox]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'combo_nf', 'aria-controls', 'nonexistent-id');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 0);
});

test('custom_select not generated when combobox has no aria-controls or aria-owns', () => {
    const combobox = makeNode('combo_na', 'combobox');
    const root = makeNode('root', 'root', [combobox]);

    const ctx = makeCtx(root);
    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 0);
});

test('custom_select not generated when popup has no option children', () => {
    const listbox = makeNode('empty_lb', 'listbox');
    const combobox = makeNode('combo_empty', 'combobox');
    const wrapper = makeNode('empty_wrap', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'empty_lb', 'id', 'empty-popup');
    setAttr(ctx, 'combo_empty', 'aria-controls', 'empty-popup');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 0);
});

test('custom_select generated when combobox has popup with options', () => {
    const opt = makeNode('ok_opt', 'option'); opt.name = 'Choice';
    const listbox = makeNode('ok_lb', 'listbox', [opt]);
    const combobox = makeNode('ok_combo', 'combobox');
    const wrapper = makeNode('ok_wrap', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ok_lb', 'id', 'ok-popup');
    setAttr(ctx, 'ok_combo', 'aria-controls', 'ok-popup');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].popupNodeId, 'ok_lb');
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 1);
});

// ── Ant Select class auxiliary ─────────────────────────────────

test('Ant Select class trigger produces exactly one custom_select', () => {
    const option1 = makeNode('ant_opt1', 'option'); option1.name = 'Shanghai';
    const option2 = makeNode('ant_opt2', 'option'); option2.name = 'Beijing';

    const dropdown = makeNode('ant_dropdown', 'listbox', [option1, option2]);
    const trigger = makeNode('ant_trigger', 'generic');
    trigger.name = 'City';

    const wrapper = makeNode('ant_wrapper', 'generic', [trigger, dropdown]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ant_trigger', 'class', 'ant-select-selector');
    setAttr(ctx, 'ant_dropdown', 'class', 'ant-select-dropdown');
    setAttr(ctx, 'ant_dropdown', 'role', 'listbox');
    setAttr(ctx, 'ant_opt1', 'aria-selected', 'true');
    setAttr(ctx, 'ant_opt2', 'value', 'beijing');

    const { controlIndex } = collect(root, ctx);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1, 'only trigger should produce custom_select, not dropdown');
    assert.strictEqual(entries[0].rootNodeId, 'ant_trigger');
    assert.strictEqual(entries[0].popupNodeId, 'ant_dropdown');
});

test('Ant Select with ant-select-item-option class detects options', () => {
    const opt1 = makeNode('aso1', 'generic'); opt1.name = 'Item A';
    const opt2 = makeNode('aso2', 'generic'); opt2.name = 'Item B';

    const dropdown = makeNode('ant_dd', 'listbox', [opt1, opt2]);
    const trigger = makeNode('ant_tr', 'generic');
    const wrapper = makeNode('ant_wr', 'generic', [trigger, dropdown]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ant_tr', 'class', 'ant-select-selector');
    setAttr(ctx, 'ant_dd', 'class', 'ant-select-dropdown');
    setAttr(ctx, 'ant_dd', 'role', 'listbox');
    setAttr(ctx, 'aso1', 'class', 'ant-select-item-option ant-select-item-option-selected');
    setAttr(ctx, 'aso1', 'value', 'item_a');
    setAttr(ctx, 'aso2', 'class', 'ant-select-item-option');

    const { controlIndex } = collect(root, ctx);

    const antEntry = Object.values(controlIndex).find((c) => c.kind === 'custom_select' && c.rootNodeId === 'ant_tr');
    assert.ok(antEntry);
    const options = antEntry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);

    const selOpt = options.find((o) => o.selected) as Record<string, unknown>;
    assert.ok(selOpt);
    assert.strictEqual(selOpt.label, 'Item A');
});

test('ant-select-dropdown alone does not produce custom_select', () => {
    const dropdown = makeNode('dd_alone', 'listbox');
    const root = makeNode('root', 'root', [dropdown]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'dd_alone', 'class', 'ant-select-dropdown');
    setAttr(ctx, 'dd_alone', 'role', 'listbox');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 0, 'dropdown class alone should not be recognized as root');
});

test('ant-select-item-option alone does not produce custom_select', () => {
    const opt = makeNode('opt_alone', 'generic'); opt.name = 'Item';
    const root = makeNode('root', 'root', [opt]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'opt_alone', 'class', 'ant-select-item-option');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 0, 'option class alone should not be recognized as root');
});

test('Ant Select root with dropdown options using ant-select-item-option class', () => {
    const opt1 = makeNode('aso3_1', 'generic'); opt1.name = 'Item A';
    const opt2 = makeNode('aso3_2', 'generic'); opt2.name = 'Item B';

    const dropdown = makeNode('aso3_dd', 'listbox', [opt1, opt2]);
    const trigger = makeNode('aso3_tr', 'generic');
    const wrapper = makeNode('aso3_wr', 'generic', [trigger, dropdown]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'aso3_tr', 'class', 'ant-select ant-select-selector');
    setAttr(ctx, 'aso3_dd', 'class', 'ant-select-dropdown');
    setAttr(ctx, 'aso3_dd', 'role', 'listbox');
    setAttr(ctx, 'aso3_1', 'class', 'ant-select-item-option ant-select-item-option-selected');
    setAttr(ctx, 'aso3_1', 'value', 'item_a');
    setAttr(ctx, 'aso3_2', 'class', 'ant-select-item-option');
    setAttr(ctx, 'aso3_2', 'value', 'item_b');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1, 'only one custom_select for Ant Select component');
    assert.strictEqual(entries[0].rootNodeId, 'aso3_tr');
    assert.strictEqual(entries[0].popupNodeId, 'aso3_dd');
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    const selOpt = options.find((o) => o.selected) as Record<string, unknown>;
    assert.ok(selOpt);
    assert.strictEqual(selOpt.label, 'Item A');
});

test('role=combobox with ant-select class produces exactly one custom_select', () => {
    const opt = makeNode('dup_opt', 'option'); opt.name = 'Choice';
    const listbox = makeNode('dup_lb', 'listbox', [opt]);
    const combobox = makeNode('dup_combo', 'combobox');
    const wrapper = makeNode('dup_wrap', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'dup_lb', 'id', 'dup-popup');
    setAttr(ctx, 'dup_combo', 'aria-controls', 'dup-popup');
    setAttr(ctx, 'dup_combo', 'class', 'ant-select');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1, 'combobox with ant-select class should produce exactly one custom_select');
    assert.strictEqual(entries[0].rootNodeId, 'dup_combo');
});

// ── General assertions ─────────────────────────────────────────

test('role field preserves original a11y semantics', () => {
    const r1 = makeNode('ar1', 'radio');
    const container = makeNode('g1', 'group', [r1]);
    const root = makeNode('root', 'root', [container]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'ar1', 'tag', 'input'); setAttr(ctx, 'ar1', 'type', 'radio'); setAttr(ctx, 'ar1', 'name', 'x'); setAttr(ctx, 'ar1', 'value', 'x');

    collect(root, ctx);
    // role must not become 'radio_group' or other component names
    assert.strictEqual(ctx.nodeIndex['ar1'].role, 'radio');
    assert.strictEqual(ctx.nodeIndex['g1'].role, 'group');
});

test('target field is not polluted with component semantics', () => {
    const opt1 = makeNode('opt1', 'option'); opt1.name = 'Opt';
    const sel = makeNode('sel1', 'generic', [opt1]);
    const root = makeNode('root', 'root', [sel]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'sel1', 'tag', 'select');
    setAttr(ctx, 'opt1', 'tag', 'option'); setAttr(ctx, 'opt1', 'value', 'v');

    collect(root, ctx);
    const selNode = ctx.nodeIndex['sel1'];
    assert.strictEqual(selNode.target, undefined, 'target should not be set by control');
});

test('controlIndex is empty object when no matching elements exist', () => {
    const div = makeNode('div1', 'generic');
    const root = makeNode('root', 'root', [div]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'div1', 'tag', 'div');

    const { controlIndex } = collect(root, ctx);
    assert.deepStrictEqual(controlIndex, {});
    assert.strictEqual(Object.keys(controlIndex).length, 0);
});

test('no control generated when registry has no collectors', () => {
    const sel = makeNode('sel1', 'generic');
    const root = makeNode('root', 'root', [sel]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'sel1', 'tag', 'select');

    const registry = createControlRegistry();
    const controlIndex = collectControlComponents(ctx, registry);
    assert.deepStrictEqual(controlIndex, {});
});

test('default production path generates non-empty controlIndex for native select', () => {
    // Simulates what generateSemanticSnapshotFromRaw would produce
    const opt = makeNode('prod_opt', 'option'); opt.name = 'Choice';
    const sel = makeNode('prod_sel', 'generic', [opt]);
    const root = makeNode('root', 'root', [sel]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'prod_sel', 'tag', 'select');
    setAttr(ctx, 'prod_opt', 'tag', 'option'); setAttr(ctx, 'prod_opt', 'value', 'v1');

    // Default registry = registerSelectOptionControls pre-registered
    const registry = createControlRegistry();
    registerSelectOptionControls(registry);

    const controlIndex = collectControlComponents(ctx, registry);
    assert.ok(Object.keys(controlIndex).length > 0, 'default registry should produce control entries');
    const ref = buildControlRef('native_select', 'prod_sel');
    assert.ok(controlIndex[ref]);
});

test('buildDomIdToNodeIdMap maps DOM id to snapshot nodeId', () => {
    const attrIndex = {
        n1: { id: 'my-dom-id', tag: 'input' },
        n2: { tag: 'div' },
        n3: { id: 'other-id', class: 'foo' },
    };
    const map = buildDomIdToNodeIdMap(attrIndex);
    assert.deepStrictEqual(map, {
        'my-dom-id': 'n1',
        'other-id': 'n3',
    });
});

test('readNodeText resolves content.ref from contentStore', () => {
    // This test validates the contentStore resolution path in register_controls
    const opt = makeNode('ct_opt', 'option');
    opt.content = { ref: 'content_ref_1' };

    const sel = makeNode('ct_sel', 'generic', [opt]);
    const root = makeNode('root', 'root', [sel]);

    const ctx = makeCtx(root);
    ctx.contentStore = { content_ref_1: 'Resolved Text' };
    setAttr(ctx, 'ct_sel', 'tag', 'select');
    setAttr(ctx, 'ct_opt', 'tag', 'option'); setAttr(ctx, 'ct_opt', 'value', 'v');

    const { controlIndex } = collect(root, ctx);
    const ref = buildControlRef('native_select', 'ct_sel');
    const options = controlIndex[ref].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 1);
    assert.strictEqual(options[0].label, 'Resolved Text');
});

// ── attr case preservation ─────────────────────────────────────

test('option value preserves original case via readAttrRaw', () => {
    const opt = makeNode('case_opt', 'option'); opt.name = 'Admin';
    const sel = makeNode('case_sel', 'generic', [opt]);
    const root = makeNode('root', 'root', [sel]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'case_sel', 'tag', 'select');
    setAttr(ctx, 'case_opt', 'tag', 'option'); setAttr(ctx, 'case_opt', 'value', 'UserAdmin');

    const { controlIndex } = collect(root, ctx);
    const ref = buildControlRef('native_select', 'case_sel');
    const options = controlIndex[ref].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 1);
    assert.strictEqual(options[0].value, 'UserAdmin');
});

test('aria-controls resolves popup with exact-case DOM id', () => {
    const option1 = makeNode('cid_opt1', 'option'); option1.name = 'Item';
    const listbox = makeNode('cid_lb', 'listbox', [option1]);
    const combobox = makeNode('cid_combo', 'combobox');
    const wrapper = makeNode('cid_wrap', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'cid_lb', 'id', 'Popup_DOM_ID');
    setAttr(ctx, 'cid_combo', 'aria-controls', 'Popup_DOM_ID');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].popupNodeId, 'cid_lb');
});

test('data-value preserves original case via readAttrRaw', () => {
    const opt1 = makeNode('dv_opt1', 'option'); opt1.name = 'Admin';
    const listbox = makeNode('dv_lb', 'listbox', [opt1]);
    const combobox = makeNode('dv_combo', 'combobox');
    const wrapper = makeNode('dv_wrap', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);

    const ctx = makeCtx(root);
    setAttr(ctx, 'dv_lb', 'id', 'popup-dv');
    setAttr(ctx, 'dv_combo', 'aria-controls', 'popup-dv');
    setAttr(ctx, 'dv_opt1', 'data-value', 'RoleA');

    const { controlIndex } = collect(root, ctx);
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 1);
    assert.strictEqual(options[0].value, 'RoleA');
});
