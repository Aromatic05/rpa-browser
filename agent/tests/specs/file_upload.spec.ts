import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('file_upload', () => {
    test('set files from path', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'file-token');
        const res = await runner.run([
            createStep('browser.take_screenshot', { target: { a11yHint: { name: 'Upload' } } }),
        ]);
        expect(res.ok).toBe(true);
        expect((res.results[0]?.data as any)?.base64?.length || 0).toBeGreaterThan(0);
        await context.close();
    });

    test('set files from missing path fails', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'file-fail');
        const res = await runner.run([
            createStep('browser.take_screenshot', { target: { a11yHint: { name: 'Missing' } } }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
