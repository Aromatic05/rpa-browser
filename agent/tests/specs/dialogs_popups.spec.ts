import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('dialogs_popups', () => {
    test('handle next dialog', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/dialog.html`);
        const runner = await setupStepRunner(page, 'dialog-token');
        const res = await runner.run([createStep('browser.snapshot', { includeA11y: false })]);
        expect(res.ok).toBe(true);
        await context.close();
    });

    test('expectPopup fails when blocked', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'popup-fail');
        const res = await runner.run([
            createStep('browser.click', { target: { a11yHint: { role: 'button', name: 'Missing' } }, timeout: 300 }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
