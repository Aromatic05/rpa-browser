import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('element_date', () => {
    test('set date on native input', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/date.html`);
        const runner = await setupStepRunner(page, 'date-token');
        const res = await runner.run([
            createStep('browser.fill', { target: { a11yHint: { name: 'Date' } }, value: '2025-01-02' }),
        ]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#nativeDate')).toHaveValue('2025-01-02');
        await context.close();
    });

    test('set date fails when no strategy matches', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/date.html`);
        const runner = await setupStepRunner(page, 'date-fail');
        const res = await runner.run([
            createStep('browser.fill', { target: { a11yHint: { name: 'Missing' } }, value: '2025-01-10' }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
