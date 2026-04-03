import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fuseDomAndA11y } from '../executors/snapshot/fusion';

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

const findById = (node: AnyNode | null | undefined, id: string): AnyNode | null => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
        const matched = findById(child, id);
        if (matched) return matched;
    }
    return null;
};

const fixturePath = path.resolve(process.cwd(), 'tests/fixtures/snapshot/catos.info.raw.json');

const loadFixture = async (): Promise<FixturePayload> => {
    const raw = await fs.readFile(fixturePath, 'utf8');
    return JSON.parse(raw) as FixturePayload;
};

test('catos fixture keeps footer links annotated in unified graph', async () => {
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

    const footerNode = findById(graph.root as AnyNode, 'n0.1.1.3');
    assert.ok(footerNode, 'footer subtree should exist');

    const footerLinkNames = new Set<string>();
    walk(footerNode, (node) => {
        if ((node.role || '').toLowerCase() !== 'link') return;
        const name = (node.name || '').trim();
        if (name) footerLinkNames.add(name);
    });

    assert.equal(footerLinkNames.has('GitHub'), true, 'footer should include GitHub link name');
    assert.equal(footerLinkNames.has('系统截图'), true, 'footer should include 系统截图 link name');
    assert.equal(footerLinkNames.has('简介'), true, 'footer should include 简介 link name');
    assert.equal(footerLinkNames.has('下载'), true, 'footer should include 下载 link name');
});
