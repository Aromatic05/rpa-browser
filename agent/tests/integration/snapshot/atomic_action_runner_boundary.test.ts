import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureControlSnapshot } from '../../../src/snapshot';

const executorPaths = {
    click: '../../../src/runner/steps/executors/click.ts',
    fill: '../../../src/runner/steps/executors/fill.ts',
    type: '../../../src/runner/steps/executors/type.ts',
    hover: '../../../src/runner/steps/executors/hover.ts',
    pressKey: '../../../src/runner/steps/executors/press_key.ts',
    scroll: '../../../src/runner/steps/executors/scroll.ts',
    screenshot: '../../../src/runner/steps/executors/take_screenshot.ts',
    drag: '../../../src/runner/steps/executors/drag_and_drop.ts',
};

const importExecutors = async () => ({
    click: (await import(executorPaths.click)).executeBrowserClick,
    fill: (await import(executorPaths.fill)).executeBrowserFill,
    type: (await import(executorPaths.type)).executeBrowserType,
    hover: (await import(executorPaths.hover)).executeBrowserHover,
    pressKey: (await import(executorPaths.pressKey)).executeBrowserPressKey,
    scroll: (await import(executorPaths.scroll)).executeBrowserScroll,
    screenshot: (await import(executorPaths.screenshot)).executeBrowserTakeScreenshot,
    drag: (await import(executorPaths.drag)).executeBrowserDragAndDrop,
});

const createDeps = (page: import('playwright').Page) => {
    const tab = { name: 'tab', page };
    const workspace = {
        tabs: {
            getActiveTab: () => tab,
            listTabs: () => [tab],
            setActiveTab: () => undefined,
        },
        browserSession: {
            start: async () => undefined,
            pageRegistry: {},
        },
    };
    return {
        resolveWorkspace: () => workspace,
        runtime: {
            awaitExecutableTab: async () => ({}),
            resolveBinding: async () => ({ page }),
        },
        config: {
            waitPolicy: {
                pageReadyTimeoutMs: 1000,
                visibleTimeoutMs: 1000,
                candidateClickTimeoutMs: 1000,
                interactionTimeoutMs: 3000,
                highlightBeforeActionMs: 0,
            },
            humanPolicy: {
                enabled: false,
                clickDelayMsRange: { min: 0, max: 0 },
                typeDelayMsRange: { min: 0, max: 0 },
            },
        },
    };
};

const nodeById = (snapshot: Awaited<ReturnType<typeof captureControlSnapshot>>, id: string): string => {
    const nodeId = Object.keys(snapshot.observation.nodes).find((candidate) => snapshot.observation.attributes[candidate]?.id === id);
    assert.ok(nodeId, `node ${id} not found`);
    return nodeId;
};

test('click fill type hover and targeted press_key execute through V2 canonical locators', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="Action">Run</button>
          <input id="Name" value="">
          <input id="RadioA" type="radio" name="choice" value="A">
          <input id="RadioB" type="radio" name="choice" value="B">
          <script>
            const button = document.querySelector('#Action');
            button.addEventListener('click', () => button.dataset.clicked = 'true');
            button.addEventListener('mouseenter', () => button.dataset.hovered = 'true');
            const input = document.querySelector('#Name');
            input.addEventListener('keydown', (event) => input.dataset.lastKey = event.key);
          </script>
        `);
        const executors = await importExecutors();
        const deps = createDeps(page);
        const snapshot = await captureControlSnapshot(page);
        const buttonNodeId = nodeById(snapshot, 'Action');
        const inputNodeId = nodeById(snapshot, 'Name');
        const radioBNodeId = nodeById(snapshot, 'RadioB');

        const click = await executors.click({
            id: 'click', name: 'browser.click', args: { nodeId: buttonNodeId },
        } as never, deps as never, 'workspace');
        assert.equal(click.ok, true);
        assert.equal(await page.locator('#Action').getAttribute('data-clicked'), 'true');

        const radioClick = await executors.click({
            id: 'radio-click', name: 'browser.click', args: { nodeId: radioBNodeId },
        } as never, deps as never, 'workspace');
        assert.equal(radioClick.ok, true);
        assert.equal(await page.locator('#RadioB').isChecked(), true);
        assert.equal(await page.locator('#RadioA').isChecked(), false);

        const fill = await executors.fill({
            id: 'fill', name: 'browser.fill', args: { nodeId: inputNodeId, value: 'Alice' },
        } as never, deps as never, 'workspace');
        assert.equal(fill.ok, true);
        assert.equal(await page.locator('#Name').inputValue(), 'Alice');

        const type = await executors.type({
            id: 'type', name: 'browser.type', args: { nodeId: inputNodeId, text: ' Bob' },
        } as never, deps as never, 'workspace');
        assert.equal(type.ok, true);
        assert.equal(await page.locator('#Name').inputValue(), 'Alice Bob');

        const hover = await executors.hover({
            id: 'hover', name: 'browser.hover', args: { nodeId: buttonNodeId },
        } as never, deps as never, 'workspace');
        assert.equal(hover.ok, true);
        assert.equal(await page.locator('#Action').getAttribute('data-hovered'), 'true');

        const press = await executors.pressKey({
            id: 'press', name: 'browser.press_key', args: { nodeId: inputNodeId, key: 'Enter' },
        } as never, deps as never, 'workspace');
        assert.equal(press.ok, true);
        assert.equal(await page.locator('#Name').getAttribute('data-last-key'), 'Enter');
    } finally {
        await browser.close();
    }
});

test('consecutive selector fills recapture stable canonical targets', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<input id="Order"><input id="Buyer">');
        const {fill} = await importExecutors();
        const deps = createDeps(page);

        for (let index = 0; index < 10; index += 1) {
            const order = await fill({
                id: `fill-order-${index}`, name: 'browser.fill', args: {selector: '#Order', value: `SO-${index}`},
            } as never, deps as never, 'workspace');
            assert.equal(order.ok, true, JSON.stringify(order.error));
            const buyer = await fill({
                id: `fill-buyer-${index}`, name: 'browser.fill', args: {selector: '#Buyer', value: `Buyer-${index}`},
            } as never, deps as never, 'workspace');
            assert.equal(buyer.ok, true, JSON.stringify(buyer.error));
        }

        assert.equal(await page.locator('#Order').inputValue(), 'SO-9');
        assert.equal(await page.locator('#Buyer').inputValue(), 'Buyer-9');
    } finally {
        await browser.close();
    }
});

test('basic actions reject ambiguous selectors without executing the first match', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button class="same">A</button><button class="same">B</button>
          <script>for (const button of document.querySelectorAll('button')) button.addEventListener('click', () => button.dataset.clicked = 'true')</script>
        `);
        const { click } = await importExecutors();
        const result = await click({
            id: 'click', name: 'browser.click', args: { selector: '.same' },
        } as never, createDeps(page) as never, 'workspace');
        assert.equal(result.ok, false);
        assert.equal(result.error?.code, 'ERR_AMBIGUOUS');
        assert.deepEqual(await page.locator('.same').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-clicked'))), [null, null]);
    } finally {
        await browser.close();
    }
});


test('target scroll screenshot and drag-and-drop use V2 canonical locators', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
        await page.setContent(`
          <div style="height:1500px"></div>
          <button id="Far">Far target</button>
          <div id="Source" draggable="true" style="width:80px;height:40px">Source</div>
          <div id="Dest" style="width:120px;height:80px">Dest</div>
          <script>
            const dest = document.querySelector('#Dest');
            dest.addEventListener('dragover', (event) => event.preventDefault());
            dest.addEventListener('drop', (event) => { event.preventDefault(); dest.dataset.dropped = 'true'; });
          </script>
        `);
        const executors = await importExecutors();
        const deps = createDeps(page);
        const snapshot = await captureControlSnapshot(page);
        const farNodeId = nodeById(snapshot, 'Far');
        const sourceNodeId = nodeById(snapshot, 'Source');
        const destNodeId = nodeById(snapshot, 'Dest');

        const scroll = await executors.scroll({
            id: 'scroll', name: 'browser.scroll', args: { nodeId: farNodeId },
        } as never, deps as never, 'workspace');
        assert.equal(scroll.ok, true);
        assert.equal(await page.locator('#Far').evaluate((node) => {
            const rect = node.getBoundingClientRect();
            return rect.top >= 0 && rect.bottom <= window.innerHeight;
        }), true);

        const screenshot = await executors.screenshot({
            id: 'screenshot', name: 'browser.take_screenshot', args: { nodeId: farNodeId, inline: true },
        } as never, deps as never, 'workspace');
        assert.equal(screenshot.ok, true);
        assert.equal(typeof screenshot.data?.base64, 'string');
        assert.equal((screenshot.data?.base64 as string).length > 100, true);

        const drag = await executors.drag({
            id: 'drag', name: 'browser.drag_and_drop', args: { sourceNodeId, destNodeId },
        } as never, deps as never, 'workspace');
        assert.equal(drag.ok, true);
        assert.equal(await page.locator('#Dest').getAttribute('data-dropped'), 'true');
    } finally {
        await browser.close();
    }
});


test('selector mapping keeps the live top-level node when another frame reuses the same id', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage();
        await page.setContent(`
          <button id="same">Top</button>
          <iframe srcdoc="<button id='same'>Frame</button>"></iframe>
          <script>document.querySelector('#same').addEventListener('click', event => event.currentTarget.dataset.clicked = 'true')</script>
        `);
        await page.locator('iframe').contentFrame().locator('#same').waitFor();
        const { click } = await importExecutors();
        const result = await click({ id: 'scope-click', name: 'browser.click', args: { selector: '#same' } } as never, createDeps(page) as never, 'workspace');
        assert.equal(result.ok, true);
        assert.equal(await page.locator('#same').getAttribute('data-clicked'), 'true');
        assert.equal(await page.locator('iframe').contentFrame().locator('#same').getAttribute('data-clicked'), null);
    } finally {
        await browser.close();
    }
});
