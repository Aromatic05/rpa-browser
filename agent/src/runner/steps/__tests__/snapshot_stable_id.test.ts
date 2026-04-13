import test from 'node:test';
import assert from 'node:assert/strict';
import { assignStableIds } from '../executors/snapshot/core/stable_id';
import { getNodeAttr, setNodeAttrs } from '../executors/snapshot/core/runtime_store';
import type { UnifiedNode } from '../executors/snapshot/core/types';

const node = (
    id: string,
    role: string,
    children: UnifiedNode[] = [],
    attrs: Record<string, string> = {},
    name?: string,
): UnifiedNode => {
    const next: UnifiedNode = {
        id,
        role,
        name,
        children,
    };
    if (Object.keys(attrs).length > 0) {
        setNodeAttrs(next, attrs);
    }
    return next;
};

const collectByBackendDomId = (root: UnifiedNode): Map<string, string> => {
    const map = new Map<string, string>();
    const walk = (current: UnifiedNode) => {
        const backend = getNodeAttr(current, 'backendDOMNodeId');
        if (backend) map.set(backend, current.id);
        for (const child of current.children) {
            walk(child);
        }
    };
    walk(root);
    return map;
};

const collectIds = (root: UnifiedNode): string[] => {
    const ids: string[] = [];
    const walk = (current: UnifiedNode) => {
        ids.push(current.id);
        for (const child of current.children) {
            walk(child);
        }
    };
    walk(root);
    return ids;
};

const buildFixtureTree = (variant: 'base' | 'reordered'): UnifiedNode => {
    const buttonA = node('n-a', 'button', [], { tag: 'button', backendDOMNodeId: '1001' }, variant === 'base' ? 'Buy' : 'Buy now');
    const buttonB = node('n-b', 'button', [], { tag: 'button', backendDOMNodeId: '1002' }, variant === 'base' ? 'Buy' : 'Buy today');
    const buttonC = node('n-c', 'button', [], { tag: 'button', backendDOMNodeId: '1003' }, 'Buy');

    const contentChildren = variant === 'base' ? [buttonA, buttonB, buttonC] : [buttonB, buttonA, buttonC];
    const content = node('content', 'group', contentChildren, { tag: 'div', backendDOMNodeId: '1100' });
    const main = node('main', 'main', [content], { tag: 'main', backendDOMNodeId: '1200' });
    return node('root', 'root', [main], { tag: 'body', backendDOMNodeId: '1300' });
};

test('stable id should prefer backend dom id and stay stable across reorder and text drift', () => {
    const left = buildFixtureTree('base');
    const right = buildFixtureTree('reordered');

    assignStableIds(left);
    assignStableIds(right);

    const leftMap = collectByBackendDomId(left);
    const rightMap = collectByBackendDomId(right);
    for (const backendId of ['1300', '1200', '1100', '1001', '1002', '1003']) {
        assert.equal(leftMap.get(backendId), rightMap.get(backendId), `backend ${backendId} should keep stable id`);
    }
});

test('stable id should stay unique when backend ids are missing', () => {
    const tree = node(
        'root',
        'root',
        [
            node('left', 'button', [], { tag: 'button' }, 'Submit'),
            node('right', 'button', [], { tag: 'button' }, 'Submit'),
            node('third', 'button', [], { tag: 'button' }, 'Submit'),
        ],
        { tag: 'main' },
    );

    assignStableIds(tree);
    const ids = collectIds(tree);
    assert.equal(new Set(ids).size, ids.length, 'assigned stable ids should be unique');
});
