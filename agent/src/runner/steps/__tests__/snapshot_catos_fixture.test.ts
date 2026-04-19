import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fuseDomAndA11y } from '../executors/snapshot/stages/fusion';

type AnyNode = {
    id?: string;
    tag?: string;
    role?: string;
    name?: string;
    text?: string;
    children?: AnyNode[];
};

type FixturePayload = {
    sourceUrl: string;
    finalUrl: string;
    title: string;
    capturedAt: string;
    domTree: AnyNode;
    a11yTree: AnyNode;
};

const walk = (node: AnyNode | null | undefined, visit: (node: AnyNode) => void) => {
    if (!node) return;
    visit(node);
    for (const child of node.children || []) {
        walk(child, visit);
    }
};

const fixturePath = path.resolve(
    process.cwd(),
    'tests/fixtures/snapshot/shop.yingdao.table-list.raw.json',
);

const loadFixture = async (): Promise<FixturePayload> => {
    const raw = await fs.readFile(fixturePath, 'utf8');
    return JSON.parse(raw) as FixturePayload;
};

test('shop.yingdao fixture keeps links normalized and target preserved', async () => {
    const fixture = await loadFixture();
    const graph = fuseDomAndA11y(fixture.domTree, fixture.a11yTree);

    const domAnchors: AnyNode[] = [];
    walk(fixture.domTree, (node) => {
        if ((node.tag || '').toLowerCase() === 'a') domAnchors.push(node);
    });

    const unifiedLinks: AnyNode[] = [];
    walk(graph.root as AnyNode, (node) => {
        if ((node.role || '').toLowerCase() === 'link') unifiedLinks.push(node);
    });

    assert.ok(unifiedLinks.length >= domAnchors.length, 'unified link nodes should not be fewer than dom anchors');

    const roleA: AnyNode[] = [];
    walk(graph.root as AnyNode, (node) => {
        if ((node.role || '').toLowerCase() === 'a') roleA.push(node);
    });
    assert.equal(roleA.length, 0, 'anchor nodes should be normalized to role=link');

    const linksWithTarget: AnyNode[] = [];
    walk(graph.root as AnyNode, (node) => {
        if ((node.role || '').toLowerCase() !== 'link') return;
        const attrs = (node as { attrs?: Record<string, string> }).attrs || {};
        const target = (node as { target?: { ref?: string } }).target;
        if ((target?.ref || '').trim() || (attrs.href || '').trim()) {
            linksWithTarget.push(node);
        }
    });

    assert.ok(linksWithTarget.length > 0, 'link nodes should preserve target info');
});
