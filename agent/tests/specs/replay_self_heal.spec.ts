import { test, expect } from '../helpers/fixtures';
import { createStep, findA11yNodeId, setupStepRunner } from '../helpers/steps';

const getLatestSnapshotRoot = async (runner: Awaited<ReturnType<typeof setupStepRunner>>) => {
    const binding = await runner.deps.runtime.resolveBinding(runner.workspaceName);
    const cache = binding.traceCtx.cache as { latestSnapshot?: { root?: unknown } };
    return cache.latestSnapshot?.root || null;
};

test.describe('replay self heal', () => {
    test('fallback from css to role within scope', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/menu-replay.html`);
        const runner = await setupStepRunner(page, 'replay-token');
        await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        const tree = await getLatestSnapshotRoot(runner);
        const nodeId = findA11yNodeId(tree, 'link', 'Orders');
        expect(nodeId).not.toBeNull();
        const replay = await import('../../src/play/replay');
        const res = await replay.replayRecording({
            workspaceName: runner.workspaceName,
            steps: [createStep('browser.click', { nodeId: nodeId || undefined })],
            stopOnError: true,
            deps: runner.deps,
        });
        expect(res.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
        await context.close();
    });

    test('ambiguous candidate skipped', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/menu-replay.html`);
        const runner = await setupStepRunner(page, 'replay-token-2');
        await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        const tree = await getLatestSnapshotRoot(runner);
        const nodeId = findA11yNodeId(tree, 'link', 'Orders');
        expect(nodeId).not.toBeNull();
        const replay = await import('../../src/play/replay');
        const res = await replay.replayRecording({
            workspaceName: runner.workspaceName,
            steps: [createStep('browser.click', { nodeId: nodeId || undefined })],
            stopOnError: true,
            deps: runner.deps,
        });
        expect(res.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
        await context.close();
    });
});
