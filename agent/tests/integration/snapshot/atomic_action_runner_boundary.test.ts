import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { captureControlSnapshot } from '../../../src/automation/snapshot';
import type { Step } from '../../../src/automation/runner/steps/types';

const executorPaths = {
    click: '../../../src/automation/runner/steps/executors/click.ts',
    fill: '../../../src/automation/runner/steps/executors/fill.ts',
    type: '../../../src/automation/runner/steps/executors/type.ts',
    hover: '../../../src/automation/runner/steps/executors/hover.ts',
    pressKey: '../../../src/automation/runner/steps/executors/press_key.ts',
    scroll: '../../../src/automation/runner/steps/executors/scroll.ts',
    screenshot: '../../../src/automation/runner/steps/executors/take_screenshot.ts',
    drag: '../../../src/automation/runner/steps/executors/drag_and_drop.ts',
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

test('recording replay uses agreeing exact hints only after the primary target fails', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        const {click, fill, type} = await importExecutors();
        const deps = createDeps(page) as never;
        const replay = {recordingReplay: true};
        const clickStep: Step<'browser.click'> = {
            id: 'save',
            name: 'browser.click',
            args: {selector: '#old-save'},
            resolve: {hint: {target: {attrs: {'data-testid': 'save'}}, raw: {locatorCandidates: [
                {kind: 'role', role: 'button', name: 'Save'},
                {kind: 'testid', testId: 'save'},
            ]}}},
        };
        await page.setContent('<button id="new-save" data-testid="save" onclick="this.dataset.clicked = true">Save</button>');
        const direct = await click(clickStep, deps, 'workspace');
        assert.equal(direct.error?.code, 'ERR_NOT_FOUND');
        assert.equal(await page.locator('#new-save').getAttribute('data-clicked'), null);

        const recovered = await click(clickStep, deps, 'workspace', replay);
        assert.equal(recovered.ok, true, JSON.stringify(recovered.error));
        assert.equal(recovered.data.resolver, 'recorded-target-fallback');
        assert.equal(await page.locator('#new-save').getAttribute('data-clicked'), 'true');

        const stale = await click({
            ...clickStep, args: {nodeId: 'node-from-a-previous-document'},
        }, deps, 'workspace', replay);
        assert.equal(stale.ok, true, JSON.stringify(stale.error));
        assert.equal(stale.data.resolver, 'recorded-target-fallback');

        await page.setContent('<button id="old-save" onclick="this.dataset.clicked = true">Original</button><button>Save</button><button data-testid="save">Save</button>');
        const exact = await click(clickStep, deps, 'workspace', replay);
        assert.equal(exact.ok, true, JSON.stringify(exact.error));
        assert.equal(exact.data.resolver, 'snapshot-v2-canonical-locator');
        assert.equal(await page.locator('#old-save').getAttribute('data-clicked'), 'true');

        await page.setContent('<label for="new-name">Customer</label><input id="new-name" placeholder="Full name">');
        const resolve = {hint: {raw: {locatorCandidates: [
            {kind: 'label', text: 'Customer'},
            {kind: 'placeholder', text: 'Full name'},
        ]}}};
        const filled = await fill({
            id: 'fill', name: 'browser.fill', args: {selector: '#old-name', value: 'Alice'}, resolve,
        }, deps, 'workspace', replay);
        assert.equal(filled.ok, true, JSON.stringify(filled.error));
        const typed = await type({
            id: 'type', name: 'browser.type', args: {selector: '#old-name', text: ' Smith'}, resolve,
        }, deps, 'workspace', replay);
        assert.equal(typed.ok, true, JSON.stringify(typed.error));
        assert.equal(await page.locator('#new-name').inputValue(), 'Alice Smith');
    } finally {
        await browser.close();
    }
});

test('recorded fallback rejects conflicting hints, duplicate names and non-visible targets', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        const {click} = await importExecutors();
        const deps = createDeps(page) as never;
        const step: Step<'browser.click'> = {
            id: 'save',
            name: 'browser.click',
            args: {selector: '#old-save'},
            resolve: {hint: {target: {attrs: {'data-testid': 'save'}}, raw: {locatorCandidates: [
                {kind: 'role', role: 'button', name: 'Save'},
                {kind: 'testid', testId: 'save'},
            ]}}},
        };
        await page.setContent('<button class="old">First</button><button class="old">Second</button><button>Save</button>');
        const ambiguousPrimary = await click({
            ...step, args: {selector: '.old'},
        }, deps, 'workspace', {recordingReplay: true});
        assert.equal(ambiguousPrimary.error?.code, 'ERR_AMBIGUOUS');
        assert.match(ambiguousPrimary.error?.message ?? '', /^selector/);

        for (const markup of [
            '<button data-testid="save">Archive</button><button>Save</button>',
            '<button>Save</button><button>Save</button>',
        ]) {
            await page.setContent(markup);
            await page.evaluate(() => document.addEventListener('click', () => {document.body.dataset.clicked = 'true';}, {once: true}));
            const result = await click(step, deps, 'workspace', {recordingReplay: true});
            assert.equal(result.error?.code, 'ERR_AMBIGUOUS');
            assert.match(result.error?.message ?? '', /recorded fallback/);
            assert.equal(await page.locator('body').getAttribute('data-clicked'), null);
        }
        await page.setContent('<button data-testid="save" hidden>Save</button>');
        const hidden = await click(step, deps, 'workspace', {recordingReplay: true});
        assert.equal(hidden.error?.code, 'ERR_NOT_FOUND');
        assert.match(JSON.stringify(hidden.error?.details), /not visible/);

        await page.setContent('<button data-testid="save" onclick="this.dataset.clicked = true">Unrelated action</button>');
        const unverified = await click({
            ...step,
            resolve: {hint: {raw: step.resolve?.hint?.raw}},
        }, deps, 'workspace', {recordingReplay: true});
        assert.equal(unverified.error?.code, 'ERR_NOT_FOUND');
        assert.equal(await page.getByTestId('save').getAttribute('data-clicked'), null);
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
