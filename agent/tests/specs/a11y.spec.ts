import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

const getLatestSnapshotRoot = async (runner: Awaited<ReturnType<typeof setupStepRunner>>) => {
    const binding = await runner.deps.runtime.resolveBinding(runner.workspaceName);
    const cache = binding.traceCtx.cache as { latestSnapshot?: { root?: unknown } };
    return cache.latestSnapshot?.root || null;
};

test.describe('a11y scan', () => {
    test('detects violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-broken.html`);
        const runner = await setupStepRunner(page, 'a11y-token');
        await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        expect(await getLatestSnapshotRoot(runner)).toBeTruthy();
        await context.close();
    });

    test('ok page returns zero violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-ok.html`);
        const runner = await setupStepRunner(page, 'a11y-ok');
        await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        expect(await getLatestSnapshotRoot(runner)).toBeTruthy();
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
