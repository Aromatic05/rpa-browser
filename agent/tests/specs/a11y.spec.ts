import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('a11y scan', () => {
    test('detects violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-broken.html`);
        const runner = await setupStepRunner(page, 'a11y-token');
        const res = await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        expect(res.ok).toBe(true);
        const a11y = (res.results[0]?.data as any)?.a11y || '';
        expect(a11y.length).toBeGreaterThan(0);
        await context.close();
    });

    test('ok page returns zero violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-ok.html`);
        const runner = await setupStepRunner(page, 'a11y-ok');
        const res = await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        expect(res.ok).toBe(true);
        const a11y = (res.results[0]?.data as any)?.a11y || '';
        expect(a11y.length).toBeGreaterThan(0);
        await context.close();
    });

    test('impact filter works', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-broken.html`);
        const runner = await setupStepRunner(page, 'a11y-filter');
        const res = await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        expect(res.ok).toBe(true);
        await context.close();
    });
});
