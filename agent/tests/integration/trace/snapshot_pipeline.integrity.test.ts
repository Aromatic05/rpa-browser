import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {getDomTree, type DomTreeNode} from '../../../src/runner/trace/dom/getDomTree';
import {
    PageSnapshotSessionStore,
    buildEntityRuleComponentSnapshots,
    buildSnapshotProjection,
    captureControlSnapshot,
    resolveSnapshotContentRef,
    type SnapshotProjectionNode,
} from '../../../src/snapshot';

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

const countDomNodes = (node: DomTreeNode | null | undefined): number =>
    node ? 1 + (node.children || []).reduce((sum, child) => sum + countDomNodes(child), 0) : 0;

const collectDomTags = (node: DomTreeNode | null | undefined, out: string[]): void => {
    if (!node) {return;}
    if (typeof node.tag === 'string') {out.push(node.tag.toLowerCase());}
    for (const child of node.children || []) {collectDomTags(child, out);}
};

const collectProjectionNodes = (
    roots: readonly SnapshotProjectionNode[],
): SnapshotProjectionNode[] => {
    const nodes: SnapshotProjectionNode[] = [];
    const visit = (node: SnapshotProjectionNode) => {
        nodes.push(node);
        node.children.forEach(visit);
    };
    roots.forEach(visit);
    return nodes;
};

test('getDomTree keeps complex structure and removes script/style nodes', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(COMPLEX_HTML, {waitUntil: 'domcontentloaded'});

        const domTree = await getDomTree(page);
        assert.ok(domTree, 'dom tree should not be null');
        const tags: string[] = [];
        collectDomTags(domTree, tags);

        assert.equal(domTree.tag, 'html');
        assert.equal(tags.includes('script'), false, 'script should be removed');
        assert.equal(tags.includes('style'), false, 'style should be removed');
        assert.ok(countDomNodes(domTree) >= 12);
    } finally {
        await browser.close();
    }
});

test('V2 capture and projection preserve canonical semantics and resolvable content refs', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(COMPLEX_HTML, {waitUntil: 'domcontentloaded'});

        const control = await captureControlSnapshot(page);
        const components = buildEntityRuleComponentSnapshots(control);
        const store = new PageSnapshotSessionStore<object>();
        const entry = await store.ensureFresh({
            pageKey: page,
            pageUrl: page.url(),
            capture: async () => ({control, form: components.form, table: components.table}),
        });
        const built = buildSnapshotProjection(entry, {});
        assert.equal(built.ok, true);
        if (!built.ok) {return;}

        const nodes = collectProjectionNodes(built.projection.roots);
        assert.ok(nodes.length >= 12, `projection should remain structurally rich, got ${nodes.length}`);
        assert.equal(nodes.some((node) => node.tag === 'script'), false);
        assert.equal(nodes.some((node) => node.tag === 'style'), false);

        const searchable = nodes.map((node) => [node.name, node.text].filter(Boolean).join(' ')).join(' ');
        for (const expected of ['A', 'B', 'Title', 'Desc', 'Name', 'Save', 'item-1', 'item-2', 'chat']) {
            assert.match(searchable, new RegExp(expected), `semantic text should be preserved: ${expected}`);
        }

        const roles = new Set(nodes.map((node) => node.role));
        for (const expected of ['navigation', 'link', 'heading', 'textbox', 'button', 'list', 'listitem', 'complementary']) {
            assert.equal(roles.has(expected), true, `semantic role should be preserved: ${expected}`);
        }

        const linkTargets = nodes
            .filter((node) => node.role === 'link')
            .map((node) => node.attributes?.href)
            .filter((value): value is string => typeof value === 'string')
            .sort();
        assert.deepEqual(linkTargets, ['/a', '/b']);

        assert.equal(built.projection.components.forms.length, 1);
        assert.equal(built.projection.components.forms[0].fields.length, 1);
        assert.equal(built.projection.components.forms[0].actions.length, 1);

        const saveNode = nodes.find((node) => node.text === 'Save');
        assert.equal(typeof saveNode?.contentRef, 'string');
        const content = resolveSnapshotContentRef(entry, saveNode?.contentRef || '');
        assert.equal(content.ok, true);
        if (content.ok) {assert.match(content.content, /Save/);}
    } finally {
        await browser.close();
    }
});
