import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('clipboard', () => {
    test('clipboard write/read', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'clip-token');
        const res = await runner.run([
            createStep('browser.fill', { target: { a11yHint: { role: 'textbox', name: 'Name' } }, value: 'hello-clip' }),
        ]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#nameInput')).toHaveValue('hello-clip');
        await context.close();
    });

    test('paste requires allowSensitive', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext({
            permissions: ['clipboard-read', 'clipboard-write'],
        });
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const runner = await setupStepRunner(page, 'clip-fail');
        const res = await runner.run([
            createStep('browser.fill', { target: { a11yHint: { role: 'textbox', name: 'Missing' } }, value: 'secret' }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
