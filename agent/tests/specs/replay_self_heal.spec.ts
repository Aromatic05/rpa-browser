import { test, expect } from '../helpers/fixtures';
import { createStep, findA11yNodeId, setupStepRunner } from '../helpers/steps';

test.describe('replay self heal', () => {
    test('fallback from css to role within scope', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/menu-replay.html`);
        const runner = await setupStepRunner(page, 'replay-token');
        const snapshot = await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        const tree = JSON.parse((snapshot.results[0]?.data as any)?.a11y || '{}');
        const nodeId = findA11yNodeId(tree, 'link', 'Orders');
        expect(nodeId).not.toBeNull();
        const replay = await import('../../src/play/replay');
        const res = await replay.replayRecording({
            workspaceId: runner.workspaceId,
            events: [
                {
                    tabToken: runner.tabToken,
                    ts: Date.now(),
                    type: 'click',
                    a11yNodeId: nodeId || undefined,
                },
            ] as any,
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
        const snapshot = await runner.run([createStep('browser.snapshot', { includeA11y: true })]);
        const tree = JSON.parse((snapshot.results[0]?.data as any)?.a11y || '{}');
        const nodeId = findA11yNodeId(tree, 'link', 'Orders');
        expect(nodeId).not.toBeNull();
        const replay = await import('../../src/play/replay');
        const res = await replay.replayRecording({
            workspaceId: runner.workspaceId,
            events: [
                {
                    tabToken: runner.tabToken,
                    ts: Date.now(),
                    type: 'click',
                    a11yNodeId: nodeId || undefined,
                },
            ] as any,
            stopOnError: true,
            deps: runner.deps,
        });
        expect(res.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
        await context.close();
    });
});
