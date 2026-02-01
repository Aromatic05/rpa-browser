import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { MemorySink } from '../../src/runner/trace/sink';
import { createTraceTools } from '../../src/runner/trace/tools';

const fixtureUrl = () => {
    const filePath = path.resolve(process.cwd(), 'tests/fixtures/trace_fixture.html');
    return pathToFileURL(filePath).toString();
};

const findNodeId = (tree: any, role: string, name: string): string | null => {
    if (!tree) return null;
    if (tree.role === role && tree.name === name) return tree.id;
    for (const child of tree.children || []) {
        const found = findNodeId(child, role, name);
        if (found) return found;
    }
    return null;
};

test(
    'trace tools integration: goto -> snapshot -> click/fill',
    { timeout: 30000 },
    async () => {
        const browser = await chromium.launch({
            headless: true,
            chromiumSandbox: false,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });
        const context = await browser.newContext();
        const page = await context.newPage();

        const sink = new MemorySink();
        const { tools } = createTraceTools({ page, context, sinks: [sink] });

        const gotoResult = await tools['trace.page.goto']({ url: fixtureUrl() });
        assert.equal(gotoResult.ok, true);

        const snap = await tools['trace.page.snapshotA11y']({ includeA11y: true, focusOnly: false });
        assert.equal(snap.ok, true);
        if (!snap.ok) {
            await browser.close();
            return;
        }

        const tree = JSON.parse(snap.data?.a11y || '{}');
        const buttonId = findNodeId(tree, 'button', 'Do Action');
        const inputId = findNodeId(tree, 'textbox', 'Name');
        assert.ok(buttonId);
        assert.ok(inputId);

        const clickResult = await tools['trace.locator.click']({ a11yNodeId: buttonId! });
        assert.equal(clickResult.ok, true);
        const fillResult = await tools['trace.locator.fill']({
            a11yNodeId: inputId!,
            value: 'hello',
        });
        assert.equal(fillResult.ok, true);

        const statusText = await page.locator('#status').textContent();
        const inputValue = await page.locator('#name-input').inputValue();
        assert.equal(statusText, 'clicked');
        assert.equal(inputValue, 'hello');

        const ops = sink.getEvents().filter((e) => e.type === 'op.end').map((e) => e.op);
        assert.deepEqual(ops, [
            'trace.page.goto',
            'trace.page.snapshotA11y',
            'trace.locator.click',
            'trace.locator.fill',
        ]);

        await browser.close();
    },
);
