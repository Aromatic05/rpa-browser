import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('element_choice', () => {
    test('check and select option', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'choice-token');
        const res = await runner.run([
            createStep('browser.click', { target: { a11yHint: { role: 'checkbox', name: 'Agree' } } }),
            createStep('browser.select_option', {
                target: { a11yHint: { role: 'combobox', name: 'Country' } },
                values: ['jp'],
            }),
        ]);
        expect(res.ok).toBe(true);
        await context.close();
    });

    test('select option missing fails', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'choice-fail');
        const res = await runner.run([
            createStep('browser.select_option', {
                target: { a11yHint: { role: 'combobox', name: 'Country' } },
                values: ['missing'],
                timeout: 200,
            }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
