import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createControlRegistry,
    collectControlComponents,
    attachControlRefsToNodes,
    buildControlRef,
} from '../../../src/runner/steps/executors/snapshot/control';
import type { ControlRegistry } from '../../../src/runner/steps/executors/snapshot/control/types';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { setNodeAttr } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { registerSelectOptionControls } from '../../../src/runner/steps/executors/select_option/register_controls';

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

const makeNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const setupRegistry = (): ControlRegistry => {
    const registry = createControlRegistry();
    registerSelectOptionControls(registry);
    return registry;
};

const collect = (root: UnifiedNode) => {
    const nodeIndex = buildNodeIndex(root);
    const registry = setupRegistry();
    const controlIndex = collectControlComponents(root, nodeIndex, registry);
    attachControlRefsToNodes(root, controlIndex);
    return { controlIndex, nodeIndex };
};

test('native_select collector detects tag=select element', () => {
    const option1 = makeNode('opt1', 'option');
    setNodeAttr(option1, 'tag', 'option');
    setNodeAttr(option1, 'value', 'val1');
    setNodeAttr(option1, 'selected', 'true');
    option1.name = 'Option One';

    const option2 = makeNode('opt2', 'option');
    setNodeAttr(option2, 'tag', 'option');
    setNodeAttr(option2, 'value', 'val2');
    option2.name = 'Option Two';

    const select = makeNode('sel', 'generic', [option1, option2]);
    setNodeAttr(select, 'tag', 'select');
    setNodeAttr(select, 'multiple', 'false');

    const root = makeNode('root', 'root', [select]);
    const { controlIndex, nodeIndex } = collect(root);

    const ref = buildControlRef('native_select', 'sel');
    assert.ok(controlIndex[ref], 'controlIndex should have native_select entry');
    assert.strictEqual(controlIndex[ref].kind, 'native_select');
    assert.strictEqual(controlIndex[ref].owner, 'browser.select_option');
    assert.ok(controlIndex[ref].capabilities.includes('select_option'));
    assert.strictEqual(controlIndex[ref].rootNodeId, 'sel');
    assert.strictEqual(controlIndex[ref].controlNodeId, 'sel');

    // Assert options in data
    const options = controlIndex[ref].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].value, 'val1');
    assert.strictEqual(options[0].label, 'Option One');
    assert.strictEqual(options[0].selected, true);
    assert.strictEqual(options[1].value, 'val2');
    assert.strictEqual(options[1].label, 'Option Two');
    assert.strictEqual(options[1].selected, false);

    // Assert state
    assert.strictEqual(controlIndex[ref].state.multiple, false);

    // Assert nodeIndex entry has control attached
    const selectNode = nodeIndex['sel'];
    assert.ok(selectNode.control);
    assert.strictEqual(selectNode.control.kind, 'native_select');
    assert.strictEqual(selectNode.control.ref, ref);

    // Assert option nodes share same control.ref
    const opt1Node = nodeIndex['opt1'];
    assert.ok(opt1Node.control);
    assert.strictEqual(opt1Node.control.ref, ref);
    const opt2Node = nodeIndex['opt2'];
    assert.ok(opt2Node.control);
    assert.strictEqual(opt2Node.control.ref, ref);

    // Assert role is not polluted
    assert.strictEqual(selectNode.role, 'generic');
    assert.strictEqual(opt1Node.role, 'option');
});

test('radio_group collector aggregates same-name input[type=radio]', () => {
    const radio1 = makeNode('r1', 'radio');
    setNodeAttr(radio1, 'tag', 'input');
    setNodeAttr(radio1, 'type', 'radio');
    setNodeAttr(radio1, 'name', 'color');
    setNodeAttr(radio1, 'value', 'red');
    setNodeAttr(radio1, 'checked', 'true');
    radio1.name = 'Red';

    const radio2 = makeNode('r2', 'radio');
    setNodeAttr(radio2, 'tag', 'input');
    setNodeAttr(radio2, 'type', 'radio');
    setNodeAttr(radio2, 'name', 'color');
    setNodeAttr(radio2, 'value', 'blue');
    radio2.name = 'Blue';

    const radio3 = makeNode('r3', 'radio');
    setNodeAttr(radio3, 'tag', 'input');
    setNodeAttr(radio3, 'type', 'radio');
    setNodeAttr(radio3, 'name', 'size');
    setNodeAttr(radio3, 'value', 'small');
    radio3.name = 'Small';

    const container = makeNode('container', 'generic', [radio1, radio2, radio3]);
    const root = makeNode('root', 'root', [container]);
    const { controlIndex, nodeIndex } = collect(root);

    // Should have radio_group for 'color' (2 radios) but NOT for 'size' (1 radio)
    const entries = Object.values(controlIndex).filter((c) => c.kind === 'radio_group');
    assert.strictEqual(entries.length, 1, 'should create one radio_group for color group with 2+ radios');

    const entry = entries[0];
    assert.strictEqual(entry.kind, 'radio_group');
    assert.strictEqual(entry.owner, 'browser.select_option');
    assert.strictEqual(entry.state.multiple, false);

    const options = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);

    // Find the checked option
    const selectedOpt = options.find((o) => o.selected === true) as Record<string, unknown> | undefined;
    assert.ok(selectedOpt, 'should have a selected option');
    assert.strictEqual(selectedOpt!.value, 'red');

    const ref = buildControlRef('radio_group', entry.rootNodeId);

    // All radio nodes in the group share the same control.ref
    const r1Node = nodeIndex['r1'];
    assert.ok(r1Node.control);
    assert.strictEqual(r1Node.control.ref, ref);

    const r2Node = nodeIndex['r2'];
    assert.ok(r2Node.control);
    assert.strictEqual(r2Node.control.ref, ref);

    // Lone radio (size) should NOT have control
    const r3Node = nodeIndex['r3'];
    assert.strictEqual(r3Node.control, undefined);

    // Role is preserved
    assert.strictEqual(r1Node.role, 'radio');
    assert.strictEqual(r2Node.role, 'radio');
});

test('checkbox_group collector aggregates same-area input[type=checkbox]', () => {
    const cb1 = makeNode('cb1', 'checkbox');
    setNodeAttr(cb1, 'tag', 'input');
    setNodeAttr(cb1, 'type', 'checkbox');
    setNodeAttr(cb1, 'value', 'apple');
    setNodeAttr(cb1, 'checked', 'true');
    cb1.name = 'Apple';

    const cb2 = makeNode('cb2', 'checkbox');
    setNodeAttr(cb2, 'tag', 'input');
    setNodeAttr(cb2, 'type', 'checkbox');
    setNodeAttr(cb2, 'value', 'banana');
    cb2.name = 'Banana';

    const cb3 = makeNode('cb3', 'checkbox');
    setNodeAttr(cb3, 'tag', 'input');
    setNodeAttr(cb3, 'type', 'checkbox');
    setNodeAttr(cb3, 'value', 'cherry');
    setNodeAttr(cb3, 'checked', 'true');
    cb3.name = 'Cherry';

    const container = makeNode('container', 'generic', [cb1, cb2, cb3]);
    const root = makeNode('root', 'root', [container]);
    const { controlIndex, nodeIndex } = collect(root);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'checkbox_group');
    assert.strictEqual(entries.length, 1, 'should create one checkbox_group');

    const entry = entries[0];
    assert.strictEqual(entry.kind, 'checkbox_group');
    assert.strictEqual(entry.owner, 'browser.select_option');
    assert.strictEqual(entry.state.multiple, true);

    const options = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 3);

    // Check selected values
    const selectedOpts = options.filter((o) => o.selected === true);
    assert.strictEqual(selectedOpts.length, 2);

    const selValues = entry.data.selectedValues as string[];
    assert.ok(selValues.includes('apple'));
    assert.ok(selValues.includes('cherry'));

    const ref = buildControlRef('checkbox_group', entry.rootNodeId);

    // All checkbox nodes share the same control.ref
    for (const id of ['cb1', 'cb2', 'cb3']) {
        const node = nodeIndex[id];
        assert.ok(node.control, `node ${id} should have control`);
        assert.strictEqual(node.control.ref, ref);
    }

    // Role is preserved
    assert.strictEqual(nodeIndex['cb1'].role, 'checkbox');
});

test('custom_select collector detects role=combobox with aria-controls listbox', () => {
    const option1 = makeNode('pop_opt1', 'option');
    setNodeAttr(option1, 'value', 'v1');
    setNodeAttr(option1, 'aria-selected', 'true');
    option1.name = 'Choice A';

    const option2 = makeNode('pop_opt2', 'option');
    setNodeAttr(option2, 'value', 'v2');
    option2.name = 'Choice B';

    const listbox = makeNode('lb1', 'listbox', [option1, option2]);
    setNodeAttr(listbox, 'role', 'listbox');

    const combobox = makeNode('combo1', 'combobox');
    setNodeAttr(combobox, 'aria-controls', 'lb1');
    setNodeAttr(combobox, 'aria-expanded', 'true');
    combobox.name = 'Select option';

    const wrapper = makeNode('wrapper', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);
    const { controlIndex, nodeIndex } = collect(root);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1, 'should create one custom_select entry');

    const entry = entries[0];
    assert.strictEqual(entry.kind, 'custom_select');
    assert.strictEqual(entry.owner, 'browser.select_option');
    assert.strictEqual(entry.rootNodeId, 'combo1');
    assert.strictEqual(entry.popupNodeId, 'lb1');
    assert.strictEqual(entry.state.expanded, true);

    const options = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 2);
    assert.strictEqual(options[0].value, 'v1');
    assert.strictEqual(options[0].label, 'Choice A');
    assert.strictEqual(options[0].selected, true);
    assert.strictEqual(options[1].value, 'v2');
    assert.strictEqual(options[1].selected, false);

    const ref = buildControlRef('custom_select', 'combo1');

    // Combobox node has control
    const comboNode = nodeIndex['combo1'];
    assert.ok(comboNode.control);
    assert.strictEqual(comboNode.control.kind, 'custom_select');
    assert.strictEqual(comboNode.control.ref, ref);

    // Option nodes share same control.ref
    const opt1Node = nodeIndex['pop_opt1'];
    assert.ok(opt1Node.control);
    assert.strictEqual(opt1Node.control.ref, ref);

    const opt2Node = nodeIndex['pop_opt2'];
    assert.ok(opt2Node.control);
    assert.strictEqual(opt2Node.control.ref, ref);

    // Role is preserved (combobox stays combobox, not renamed to component semantic)
    assert.strictEqual(comboNode.role, 'combobox');
    assert.strictEqual(opt1Node.role, 'option');
});

test('custom_select collector handles aria-owns fallback', () => {
    const option1 = makeNode('po1', 'option');
    option1.name = 'Item 1';

    const listbox = makeNode('lb_owns', 'listbox', [option1]);

    const combobox = makeNode('combo_owns', 'combobox');
    setNodeAttr(combobox, 'aria-owns', 'lb_owns');

    const wrapper = makeNode('wrapper', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);
    const { controlIndex } = collect(root);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].popupNodeId, 'lb_owns');

    const options = entries[0].data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 1);
});

test('Ant Select single (combobox + listbox) snapshot output', () => {
    // Simulate Ant Design Select component structure:
    // A combobox div with aria-controls pointing to a dropdown listbox
    const option1 = makeNode('ant_opt1', 'option');
    setNodeAttr(option1, 'aria-selected', 'true');
    option1.name = 'Shanghai';

    const option2 = makeNode('ant_opt2', 'option');
    option2.name = 'Beijing';

    const option3 = makeNode('ant_opt3', 'option');
    option3.name = 'Guangzhou';

    const listbox = makeNode('ant_listbox', 'listbox', [option1, option2, option3]);
    setNodeAttr(listbox, 'role', 'listbox');

    const combobox = makeNode('ant_select', 'combobox');
    setNodeAttr(combobox, 'tag', 'div');
    setNodeAttr(combobox, 'class', 'ant-select-selector');
    setNodeAttr(combobox, 'aria-controls', 'ant_listbox');
    setNodeAttr(combobox, 'aria-expanded', 'false');
    combobox.name = 'City';

    const wrapper = makeNode('ant_wrapper', 'generic', [combobox, listbox]);
    const root = makeNode('root', 'root', [wrapper]);
    const { controlIndex, nodeIndex } = collect(root);

    const entries = Object.values(controlIndex).filter((c) => c.kind === 'custom_select');
    assert.strictEqual(entries.length, 1);

    const entry = entries[0];
    assert.strictEqual(entry.owner, 'browser.select_option');
    assert.ok(entry.capabilities.includes('select_option'));
    assert.strictEqual(entry.rootNodeId, 'ant_select');
    assert.strictEqual(entry.popupNodeId, 'ant_listbox');
    assert.strictEqual(entry.state.expanded, false);

    const options = entry.data.options as Array<Record<string, unknown>>;
    assert.strictEqual(options.length, 3);
    assert.strictEqual(options[0].label, 'Shanghai');
    assert.strictEqual(options[0].selected, true);

    const selValues = entry.data.selectedValues as string[];
    const selLabels = entry.data.selectedLabels as string[];
    assert.ok(selLabels.includes('Shanghai'));

    // Verify optionMatchHints exists
    const hints = entry.data.optionMatchHints as string[];
    assert.strictEqual(hints.length, 3);
    assert.ok(hints.includes('Shanghai'));

    const ref = buildControlRef('custom_select', 'ant_select');

    // Verify control attached to combobox node
    const selectNode = nodeIndex['ant_select'];
    assert.ok(selectNode.control);
    assert.strictEqual(selectNode.control.kind, 'custom_select');
    assert.strictEqual(selectNode.control.ref, ref);

    // Verify all option nodes share same control.ref
    for (const id of ['ant_opt1', 'ant_opt2', 'ant_opt3']) {
        const optNode = nodeIndex[id];
        assert.ok(optNode.control, `option ${id} should have control`);
        assert.strictEqual(optNode.control.ref, ref);
    }

    // Assert role is preserved as original a11y semantics
    assert.strictEqual(selectNode.role, 'combobox');
    assert.strictEqual(nodeIndex['ant_opt1'].role, 'option');
    assert.strictEqual(nodeIndex['ant_listbox'].role, 'listbox');

    // Assert target is not polluted with component semantics
    assert.strictEqual(selectNode.target, undefined);
});

test('no control generated when no matching elements exist', () => {
    const div = makeNode('div1', 'generic');
    setNodeAttr(div, 'tag', 'div');
    div.name = 'Just a div';

    const root = makeNode('root', 'root', [div]);
    const { controlIndex } = collect(root);

    assert.strictEqual(Object.keys(controlIndex).length, 0);
});

test('controlIndex is empty object when registry has no collectors', () => {
    const div = makeNode('div1', 'generic');
    setNodeAttr(div, 'tag', 'select');
    const root = makeNode('root', 'root', [div]);
    const nodeIndex = buildNodeIndex(root);
    const emptyRegistry = createControlRegistry();

    const controlIndex = collectControlComponents(root, nodeIndex, emptyRegistry);
    assert.strictEqual(Object.keys(controlIndex).length, 0);
});
