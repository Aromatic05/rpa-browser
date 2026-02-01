import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('element_form', () => {
    test('fill writes text', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'form-token');
        const res = await runner.run([
            createStep('browser.fill', { target: { a11yHint: { name: 'Name' } }, value: 'hello' }),
        ]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#nameResult')).toHaveText('hello');
        await context.close();
    });

    test('type fails on missing selector', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'form-fail');
        const res = await runner.run([
            createStep('browser.type', { target: { a11yHint: { name: 'Missing' } }, text: 'x', timeout: 200 }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
