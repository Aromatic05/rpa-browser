import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { getDomTree, type DomTreeNode } from '../../src/runner/trace/dom/getDomTree';
import { generateSemanticSnapshot } from '../../src/runner/steps/executors/snapshot/pipeline/snapshot';

type TreeNode = {
    id?: string;
    role?: string;
    tag?: string;
    text?: string;
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

const collectTexts = (node: TreeNode | null | undefined, out: string[]) => {
    if (!node) {return;}
    if (typeof node.text === 'string' && node.text.trim()) {out.push(node.text.trim());}
    for (const child of node.children || []) {
        collectTexts(child, out);
    }
};

const shape = (node: TreeNode | null | undefined): string => {
    if (!node) {return 'x';}
    return `(${(node.children || []).map((child) => shape(child)).join('')})`;
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

test('generateSemanticSnapshot should preserve dom subtree shape when no pruning rule is active', async () => {
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

        assert.equal(
            snapshotMainCount,
            domCount,
            `main subtree should keep all dom nodes (dom=${domCount}, snapshotMain=${snapshotMainCount})`,
        );

        assert.equal(
            shape(snapshotMain as TreeNode),
            shape(domTree as TreeNode),
            'main subtree shape should match dom tree shape',
        );

        const domTexts: string[] = [];
        const snapshotTexts: string[] = [];
        collectTexts(domTree as TreeNode, domTexts);
        collectTexts(snapshotMain as TreeNode, snapshotTexts);

        assert.deepEqual(
            snapshotTexts.sort(),
            domTexts.sort(),
            'text-bearing nodes should be preserved in snapshot main subtree',
        );

        assert.equal(snapshot.root.role, 'root');
        assert.ok(countNodes(snapshot.root as TreeNode) >= snapshotMainCount + 1);
    } finally {
        await browser.close();
    }
});
