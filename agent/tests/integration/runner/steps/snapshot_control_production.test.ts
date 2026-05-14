import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSemanticSnapshotFromRaw } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';

const walk = (node: any, visitor: (node: any) => void) => {
    visitor(node);
    for (const child of node.children || []) {
        walk(child, visitor);
    }
};

test('generateSemanticSnapshotFromRaw produces controlIndex via default registry', () => {
    const raw = {
        domTree: {
            id: 'n0',
            tag: 'html',
            children: [
                {
                    id: 'n0.1',
                    tag: 'body',
                    backendDOMNodeId: '1',
                    attrs: { tag: 'body', backendDOMNodeId: '1' },
                    children: [
                        {
                            id: 'n0.1.0',
                            tag: 'select',
                            backendDOMNodeId: '2',
                            attrs: { tag: 'select', backendDOMNodeId: '2' },
                            children: [
                                {
                                    id: 'n0.1.0.0',
                                    tag: 'option',
                                    text: 'Option One',
                                    backendDOMNodeId: '3',
                                    attrs: { tag: 'option', value: 'val1', backendDOMNodeId: '3' },
                                    children: [],
                                },
                                {
                                    id: 'n0.1.0.1',
                                    tag: 'option',
                                    text: 'Option Two',
                                    backendDOMNodeId: '4',
                                    attrs: { tag: 'option', value: 'val2', selected: 'true', backendDOMNodeId: '4' },
                                    children: [],
                                },
                            ],
                        },
                    ],
                },
            ],
        },
        a11yTree: {
            role: 'RootWebArea',
            children: [
                { role: 'body', backendDOMNodeId: '1', children: [
                    { role: 'combobox', name: 'Select', backendDOMNodeId: '2', children: [
                        { role: 'option', name: 'Option One', backendDOMNodeId: '3' },
                        { role: 'option', name: 'Option Two', backendDOMNodeId: '4' },
                    ]},
                ]},
            ],
        },
    };

    const snapshot = generateSemanticSnapshotFromRaw(raw as any);

    // controlIndex must exist and be an object
    assert.ok(snapshot.controlIndex, 'controlIndex should exist');
    assert.strictEqual(typeof snapshot.controlIndex, 'object');
    assert.ok(!Array.isArray(snapshot.controlIndex));

    // native_select must be detected via default registry
    const selectEntries = Object.values(snapshot.controlIndex).filter(
        (c) => c.kind === 'native_select',
    );
    assert.strictEqual(selectEntries.length, 1, 'default registry should detect native select');
    const selEntry = selectEntries[0];
    assert.strictEqual(selEntry.owner, 'browser.select_option');
    assert.ok(selEntry.capabilities.includes('select_option'));
    assert.ok(Array.isArray(selEntry.data.options), 'options should be an array');

    // node.control must be attached to the select root node
    let selectControlCount = 0;
    walk(snapshot.root, (node: any) => {
        if (node.control) {
            selectControlCount += 1;
            assert.strictEqual(typeof node.control.kind, 'string');
            assert.strictEqual(typeof node.control.ref, 'string');
        }
    });
    assert.ok(selectControlCount >= 1, 'select node should have control ref');

    // role must preserve original a11y semantics
    let comboboxCount = 0;
    walk(snapshot.root, (node: any) => {
        if (node.role === 'combobox') {
            comboboxCount += 1;
        }
        // role should never be set to a component kind
        assert.notStrictEqual(node.role, 'native_select');
        assert.notStrictEqual(node.role, 'custom_select');
        assert.notStrictEqual(node.role, 'radio_group');
        assert.notStrictEqual(node.role, 'checkbox_group');
    });
    assert.ok(comboboxCount > 0, 'combobox role should be preserved');

    // target must not be polluted
    walk(snapshot.root, (node: any) => {
        if (node.control) {
            assert.strictEqual(node.target, undefined, 'control nodes should not have target set');
        }
    });
});

test('generateSemanticSnapshotFromRaw returns empty controlIndex when no matching elements', () => {
    const raw = {
        domTree: {
            id: 'n0',
            tag: 'html',
            children: [
                {
                    id: 'n0.1',
                    tag: 'body',
                    backendDOMNodeId: '1',
                    attrs: { tag: 'body', backendDOMNodeId: '1' },
                    children: [
                        {
                            id: 'n0.1.0',
                            tag: 'div',
                            text: 'Hello',
                            backendDOMNodeId: '2',
                            attrs: { tag: 'div', backendDOMNodeId: '2' },
                            children: [],
                        },
                    ],
                },
            ],
        },
        a11yTree: {
            role: 'RootWebArea',
            children: [
                { role: 'body', backendDOMNodeId: '1', children: [
                    { role: 'generic', name: 'Hello', backendDOMNodeId: '2' },
                ]},
            ],
        },
    };

    const snapshot = generateSemanticSnapshotFromRaw(raw as any);

    assert.ok(snapshot.controlIndex, 'controlIndex should exist');
    assert.strictEqual(typeof snapshot.controlIndex, 'object');
    assert.strictEqual(Object.keys(snapshot.controlIndex).length, 0, 'no matching elements => empty controlIndex');
});
