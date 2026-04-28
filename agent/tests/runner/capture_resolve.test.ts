import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createStep, setupStepRunner } from '../helpers/steps';

test('runSteps executes browser.capture_resolve without mutating page state', async () => {
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(`
            <main>
              <button id="save-btn" type="button">Save Order</button>
            </main>
        `);

        const beforeHtml = await page.locator('body').innerHTML();
        const runner = await setupStepRunner(page, 'capture-resolve-token');
        const result = await runner.run([
            createStep('browser.capture_resolve', {
                selector: '#save-btn',
            }),
        ]);
        const afterHtml = await page.locator('body').innerHTML();

        assert.equal(result.ok, true);
        const data = result.results[0]?.data as any;
        assert.equal(typeof data?.resolve, 'object');
        assert.equal(data?.resolve?.hint?.target?.nodeId?.length > 0, true);
        assert.equal(data?.warnings?.includes('AMBIGUOUS_TARGET'), false);
        assert.equal(beforeHtml, afterHtml);

        await context.close();
    } finally {
        await browser.close();
    }
});
