import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('navigation', () => {
    test('page.goto succeeds', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const runner = await setupStepRunner(page, 'nav-token');
        const res = await runner.run([
            createStep('browser.goto', { url: `${fixtureURL}/choices.html` }),
        ]);
        expect(res.ok).toBe(true);
        await context.close();
    });

    test('page.goto fails on invalid url', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        const runner = await setupStepRunner(page, 'nav-timeout');
        const res = await runner.run([
            createStep('browser.goto', { url: 'http://127.0.0.1:9', timeout: 200 }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
