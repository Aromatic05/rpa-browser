import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('element_click', () => {
    test('click updates UI', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'click-token');
        const res = await runner.run([
            createStep('browser.click', { target: { a11yHint: { role: 'button', name: 'Click Me' } } }),
        ]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#clickResult')).toHaveText('clicked');
        await context.close();
    });

    test('click missing selector fails', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'click-fail');
        const res = await runner.run([
            createStep('browser.click', { target: { a11yHint: { role: 'button', name: 'Missing' } }, timeout: 200 }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
