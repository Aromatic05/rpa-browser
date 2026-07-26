import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getDomTree, type DomTreeNode } from '../../../src/runner/trace/dom/getDomTree';
import { generateSemanticSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/snapshot';

type TreeNode = {
    id?: string;
    role?: string;
    tag?: string;
    text?: string;
    name?: string;
    content?: string | { ref?: string };
    target?: { ref?: string; kind?: string };
    children?: TreeNode[];
};

const COMPLEX_HTML = `
<!doctype html>
<html>
  <head>
    <title>Snapshot Integrity</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>body { margin: 0; }</style>
    <script>window.__x = 1;</script>
  </head>
  <body>
    <header>
      <nav>
        <a href="/a">A</a>
        <a href="/b">B</a>
      </nav>
    </header>
    <main>
      <section>
        <h1>Title</h1>
        <p>Desc</p>
        <form>
          <label for="name">Name</label>
          <input id="name" name="name" placeholder="your name" />
          <button type="submit">Save</button>
        </form>
      </section>
      <ul>
        <li>item-1</li>
        <li>item-2</li>
      </ul>
    </main>
    <aside style="position:fixed; z-index:40; top: 0; right: 0; width: 120px; height: 80px;">
      <button>chat</button>
    </aside>
    <script>console.log('tail script')</script>
  </body>
</html>
`;

const countNodes = (node: TreeNode | null | undefined): number => {
    if (!node) {return 0;}
    return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
};

const collectTags = (node: TreeNode | null | undefined, out: string[]) => {
    if (!node) {return;}
    if (typeof node.tag === 'string') {out.push(node.tag.toLowerCase());}
    for (const child of node.children || []) {
        collectTags(child, out);
    }
};

const collectSemanticTexts = (node: TreeNode | null | undefined, out: Set<string>) => {
    if (!node) {return;}
    for (const value of [node.name, typeof node.content === 'string' ? node.content : undefined]) {
        const text = value?.trim();
        if (text) {out.add(text);}
    }
    for (const child of node.children || []) {
        collectSemanticTexts(child, out);
    }
};

const collectRoles = (node: TreeNode | null | undefined, out: Set<string>) => {
    if (!node) {return;}
    if (node.role) {out.add(node.role);}
    for (const child of node.children || []) {
        collectRoles(child, out);
    }
};

const collectNodes = (node: TreeNode | null | undefined, out: TreeNode[]) => {
    if (!node) {return;}
    out.push(node);
    for (const child of node.children || []) {
        collectNodes(child, out);
    }
};

test('getDomTree keeps complex structure and removes script/style nodes', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(COMPLEX_HTML, { waitUntil: 'domcontentloaded' });

        const domTree = await getDomTree(page);
        assert.ok(domTree, 'dom tree should not be null');

        const tags: string[] = [];
        collectTags(domTree as DomTreeNode, tags);

        assert.equal((domTree as DomTreeNode).tag, 'html');
        assert.equal(tags.includes('script'), false, 'script should be removed');
        assert.equal(tags.includes('style'), false, 'style should be removed');

        const nodeCount = countNodes(domTree as DomTreeNode);
        assert.ok(nodeCount >= 12, `node count should be rich enough, got ${nodeCount}`);
    } finally {
        await browser.close();
    }
});

test('generateSemanticSnapshot preserves semantic content while compressing wrappers', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(COMPLEX_HTML, { waitUntil: 'domcontentloaded' });

        const domTree = await getDomTree(page);
        assert.ok(domTree, 'dom tree should not be null');

        const snapshot = await generateSemanticSnapshot(page);
        const snapshotMain = snapshot.root.children[0];
        assert.ok(snapshotMain, 'snapshot main subtree should exist');

        const domCount = countNodes(domTree as TreeNode);
        const snapshotMainCount = countNodes(snapshotMain as TreeNode);

        assert.ok(
            snapshotMainCount >= 12 && snapshotMainCount <= domCount,
            `semantic snapshot should remain structurally rich without expanding the DOM (dom=${domCount}, snapshotMain=${snapshotMainCount})`,
        );

        const semanticTexts = new Set<string>();
        collectSemanticTexts(snapshotMain as TreeNode, semanticTexts);
        for (const expected of ['A', 'B', 'Title', 'Desc', 'Name', 'Save', 'item-1', 'item-2', 'chat']) {
            assert.equal(semanticTexts.has(expected), true, `semantic text should be preserved: ${expected}`);
        }

        const roles = new Set<string>();
        collectRoles(snapshotMain as TreeNode, roles);
        for (const expected of ['navigation', 'link', 'heading', 'form', 'textbox', 'button', 'list', 'listitem', 'complementary']) {
            assert.equal(roles.has(expected), true, `semantic role should be preserved: ${expected}`);
        }

        const nodes: TreeNode[] = [];
        collectNodes(snapshotMain as TreeNode, nodes);
        const linkTargets = nodes
            .filter((node) => node.role === 'link')
            .map((node) => node.target?.ref)
            .sort();
        assert.deepEqual(linkTargets, ['/a', '/b']);

        assert.equal(snapshot.root.role, 'root');
        assert.ok(countNodes(snapshot.root as TreeNode) >= snapshotMainCount + 1);
    } finally {
        await browser.close();
    }
});
