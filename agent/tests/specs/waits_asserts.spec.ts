import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('waits_asserts', () => {
    test('assert text contains', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'assert-token');
        const res = await runner.run([createStep('browser.snapshot', { includeA11y: false })]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#clickResult')).toContainText('idle');
        await context.close();
    });

    test('assert visible fails', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<div id="hidden" style="display:none">hidden</div>');
        const runner = await setupStepRunner(page, 'assert-fail');
        const res = await runner.run([
            createStep('browser.click', { target: { a11yHint: { role: 'button', name: 'Missing' } } }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
