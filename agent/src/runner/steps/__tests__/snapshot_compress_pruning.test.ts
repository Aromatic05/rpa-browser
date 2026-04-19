import test from 'node:test';
import assert from 'node:assert/strict';
import { compress } from '../executors/snapshot/stages/compress';
import { getNodeContent, setNodeAttrs, setNodeBbox, setNodeContent } from '../executors/snapshot/core/runtime_store';
import type { UnifiedNode } from '../executors/snapshot/core/types';

const createNode = (id: string, role: string, children: UnifiedNode[] = []): UnifiedNode => ({
    id,
    role,
    children,
});

const collectIds = (root: UnifiedNode): string[] => {
    const ids: string[] = [];
    const walk = (node: UnifiedNode) => {
        ids.push(node.id);
        for (const child of node.children) {
            walk(child);
        }
    };
    walk(root);
    return ids;
};

test('compress prunes hidden subtree before semantic protection', () => {
    const hiddenButton = createNode('btn-hidden', 'button');
    const hiddenWrapper = createNode('hidden-wrapper', 'div', [hiddenButton]);
    const visibleButton = createNode('btn-visible', 'button');
    const root = createNode('root', 'root', [hiddenWrapper, visibleButton]);

    setNodeAttrs(hiddenWrapper, { tag: 'div', style: 'display: none;' });
    setNodeAttrs(hiddenButton, { tag: 'button' });
    setNodeAttrs(visibleButton, { tag: 'button' });

    const out = compress(root);
    assert.ok(out);

    const ids = collectIds(out);
    assert.ok(!ids.includes('hidden-wrapper'));
    assert.ok(!ids.includes('btn-hidden'));
    assert.ok(ids.includes('btn-visible'));
});

test('compress prunes zero-size decorative node', () => {
    const spinner = createNode('spinner', 'i');
    const label = createNode('label', 'text');
    const root = createNode('root', 'root', [spinner, label]);

    setNodeAttrs(spinner, { tag: 'i', class: 'icon loading' });
    setNodeBbox(spinner, { x: 0, y: 0, width: 0, height: 0 });
    setNodeAttrs(label, { tag: 'span' });
    setNodeContent(label, '处理中');

    const out = compress(root);
    assert.ok(out);

    const ids = collectIds(out);
    assert.ok(!ids.includes('spinner'));
    assert.ok(ids.includes('label'));
});

test('compress merges lifted text with near-duplicate elimination', () => {
    const duplicate = createNode('dup', 'span');
    const suffix = createNode('suffix', 'span');
    const heading = createNode('heading', 'heading', [duplicate, suffix]);
    const root = createNode('root', 'root', [heading]);

    setNodeAttrs(heading, { tag: 'h2' });
    setNodeContent(heading, '订单列表');
    setNodeAttrs(duplicate, { tag: 'span' });
    setNodeContent(duplicate, '订单 列表!!!');
    setNodeAttrs(suffix, { tag: 'span' });
    setNodeContent(suffix, '（今日）');

    const out = compress(root);
    assert.ok(out);

    assert.equal(out.children.length, 1);
    assert.equal(out.children[0]?.children.length, 0);
    assert.equal(getNodeContent(out.children[0] as UnifiedNode), '订单列表 （今日）');
});
