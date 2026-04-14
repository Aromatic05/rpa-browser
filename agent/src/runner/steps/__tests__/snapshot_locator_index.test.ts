import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLocatorIndex } from '../executors/snapshot/indexes/locator';
import type { UnifiedNode } from '../executors/snapshot/core/types';
import { setNodeAttr } from '../executors/snapshot/core/runtime_store';

test('locator index includes menuitem nodes with executable role locator', () => {
    const root: UnifiedNode = {
        id: 'root_test',
        role: 'root',
        children: [
            {
                id: 'menuitem_test',
                role: 'menuitem',
                name: '网页操作',
                content: '网页操作',
                children: [],
            },
        ],
    };
    setNodeAttr(root.children[0], 'backendDOMNodeId', '1001');

    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex: {
            entities: {},
            byNodeId: {},
        },
    });

    assert.ok(locatorIndex.menuitem_test, 'menuitem should be indexed');
    assert.equal(locatorIndex.menuitem_test.origin.primaryDomId, '1001');
    assert.equal(locatorIndex.menuitem_test.direct?.kind, 'role');
    assert.equal(locatorIndex.menuitem_test.direct?.query, 'menuitem:网页操作');
});

test('javascript href link falls back to role locator', () => {
    const root: UnifiedNode = {
        id: 'root_test2',
        role: 'root',
        children: [
            {
                id: 'link_test',
                role: 'link',
                name: '确认发货',
                content: '确认发货',
                children: [],
            },
        ],
    };
    setNodeAttr(root.children[0], 'backendDOMNodeId', '2001');
    setNodeAttr(root.children[0], 'href', 'javascript:;');

    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex: {
            entities: {},
            byNodeId: {},
        },
    });

    assert.ok(locatorIndex.link_test, 'link should be indexed');
    assert.equal(locatorIndex.link_test.direct?.kind, 'role');
    assert.equal(locatorIndex.link_test.direct?.query, 'link:确认发货');
});

test('tab nodes are indexed for id-based click', () => {
    const root: UnifiedNode = {
        id: 'root_test3',
        role: 'root',
        children: [
            {
                id: 'tab_test',
                role: 'tab',
                name: '剪切板',
                content: '剪切板',
                children: [],
            },
        ],
    };
    setNodeAttr(root.children[0], 'backendDOMNodeId', '3001');

    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex: {
            entities: {},
            byNodeId: {},
        },
    });

    assert.ok(locatorIndex.tab_test, 'tab should be indexed');
    assert.equal(locatorIndex.tab_test.direct?.kind, 'role');
    assert.equal(locatorIndex.tab_test.direct?.query, 'tab:剪切板');
});

test('textbox with placeholder uses css direct locator', () => {
    const root: UnifiedNode = {
        id: 'root_test4',
        role: 'root',
        children: [
            {
                id: 'textbox_test',
                role: 'textbox',
                children: [],
            },
        ],
    };
    setNodeAttr(root.children[0], 'backendDOMNodeId', '4001');
    setNodeAttr(root.children[0], 'tag', 'input');
    setNodeAttr(root.children[0], 'placeholder', '商品名称');

    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex: {
            entities: {},
            byNodeId: {},
        },
    });

    assert.ok(locatorIndex.textbox_test, 'textbox should be indexed');
    assert.equal(locatorIndex.textbox_test.direct?.kind, 'css');
    assert.equal(locatorIndex.textbox_test.direct?.query, 'input[placeholder="商品名称"]');
});

test('checkbox uses input type+value css locator to avoid label text mismatch', () => {
    const root: UnifiedNode = {
        id: 'root_test5',
        role: 'root',
        children: [
            {
                id: 'checkbox_test',
                role: 'checkbox',
                name: 'red',
                children: [],
            },
        ],
    };
    setNodeAttr(root.children[0], 'backendDOMNodeId', '5001');
    setNodeAttr(root.children[0], 'tag', 'input');
    setNodeAttr(root.children[0], 'type', 'checkbox');
    setNodeAttr(root.children[0], 'value', 'red');

    const locatorIndex = buildLocatorIndex({
        root,
        entityIndex: {
            entities: {},
            byNodeId: {},
        },
    });

    assert.ok(locatorIndex.checkbox_test, 'checkbox should be indexed');
    assert.equal(locatorIndex.checkbox_test.direct?.kind, 'css');
    assert.equal(locatorIndex.checkbox_test.direct?.query, 'input[type="checkbox"][value="red"]');
});
