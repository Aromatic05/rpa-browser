import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('element_scroll', () => {
    test('page.scrollBy moves viewport', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<div style="height:2000px"></div>');
        const runner = await setupStepRunner(page, 'scroll-token');
        const res = await runner.run([createStep('browser.scroll', { direction: 'down', amount: 200 })]);
        expect(res.ok).toBe(true);
        await context.close();
    });

    test('scrollIntoView fails for missing selector', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent('<div style="height:2000px"></div>');
        const runner = await setupStepRunner(page, 'scroll-fail');
        const res = await runner.run([
            createStep('browser.scroll', { target: { a11yHint: { role: 'button', name: 'Missing' } } }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
