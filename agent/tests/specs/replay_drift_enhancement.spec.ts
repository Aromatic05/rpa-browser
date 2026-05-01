import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';
import { replayRecording } from '../../src/play/replay';
import type { StepUnion } from '../../src/runner/steps/types';
import type { RecordingEnhancementMap } from '../../src/record/types';
import type { SnapshotResult } from '../../src/runner/steps/executors/snapshot/core/types';

const createReplayStepContext = (runner: Awaited<ReturnType<typeof setupStepRunner>>) => ({
    workspaceName: runner.workspaceName,
    initialTabName: runner.tabId,
    initialTabName: runner.tabName,
    pageRegistry: {
        listTabs: (workspaceName: string) => runner.pageRegistry.listTabs(workspaceName),
        resolveTabNameFromToken: (tabName: string) => {
            try {
                return runner.pageRegistry.resolveTabBinding(tabName).tabId;
            } catch {
                return undefined;
            }
        },
        resolveTabNameFromRef: (tabRef: string) => tabRef || undefined,
    },
    deps: runner.deps,
});

const getLatestSnapshot = async (runner: Awaited<ReturnType<typeof setupStepRunner>>) => {
    const binding = await runner.deps.runtime.resolveBinding(runner.workspaceName);
    const cache = binding.traceCtx.cache as { latestSnapshot?: unknown };
    return cache.latestSnapshot as SnapshotResult | undefined;
};

const findNodeIdByAttr = (snapshot: SnapshotResult, attrName: string, attrValue: string): string | undefined => {
    for (const [nodeId, attrs] of Object.entries(snapshot.attrIndex || {})) {
        if (attrs?.[attrName] === attrValue) {return nodeId;}
    }
    return undefined;
};

test.describe('replay drift enhancement', () => {
    test('scenario 1: list index drift recovers same business row (Li Si)', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(`${fixtureURL}/drift_list_v1.html`);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', '');

        await page.goto(`${fixtureURL}/drift_list_v2.html`);
        const runner = await setupStepRunner(page, 'drift-list-token');

        const replaySteps: StepUnion[] = [
            createStep('browser.snapshot', { includeA11y: true }),
            {
                id: 'drift-list-click',
                name: 'browser.click',
                args: { nodeId: 'stale-node-id-list' },
                meta: { source: 'record', ts: Date.now(), tabName: runner.tabName, tabId: runner.tabId },
            },
        ];

        const enrichments: RecordingEnhancementMap = {
            'drift-list-click': {
                version: 1,
                eventType: 'click',
                resolveHint: {
                    target: {
                        primaryDomId: 'stale-dom-id',
                        role: 'button',
                        tag: 'button',
                        name: '编辑 李四',
                    },
                    raw: {
                        selector: 'table#users tbody tr:nth-of-type(2) button.edit-btn',
                    },
                },
                resolvePolicy: {
                    allowIndexDrift: true,
                    requireVisible: true,
                },
            },
        };

        const result = await replayRecording({
            ...createReplayStepContext(runner),
            steps: replaySteps,
            enrichments,
            stopOnError: true,
        });

        expect(result.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', '李四');
        await expect(page.locator('#result')).toHaveText('李四');
        expect(await page.locator('body').getAttribute('data-clicked')).not.toBe('赵六');
        expect(await page.locator('body').getAttribute('data-clicked')).not.toBe('张三');

        await context.close();
    });

    test('scenario 4: same-name buttons require scope narrowing', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(`${fixtureURL}/drift_scope_v1.html`);
        await page.goto(`${fixtureURL}/drift_scope_v2.html`);
        const runner = await setupStepRunner(page, 'drift-scope-token');

        const warmup = await replayRecording({
            ...createReplayStepContext(runner),
            steps: [createStep('browser.snapshot', { includeA11y: true })],
            stopOnError: true,
        });
        expect(warmup.ok).toBe(true);

        const snapshot = await getLatestSnapshot(runner);
        expect(snapshot).toBeTruthy();
        const mainScopeNodeId = snapshot ? findNodeIdByAttr(snapshot, 'id', 'main-form') : undefined;
        expect(mainScopeNodeId).toBeTruthy();

        const step: StepUnion = {
            id: 'drift-scope-save',
            name: 'browser.click',
            args: { nodeId: 'stale-node-id-scope' },
            meta: { source: 'record', ts: Date.now(), tabName: runner.tabName, tabId: runner.tabId },
        };

        const enrichments: RecordingEnhancementMap = {
            'drift-scope-save': {
                version: 1,
                eventType: 'click',
                resolveHint: {
                    locator: {
                        direct: { kind: 'css', query: 'button.save-btn', fallback: 'button.save-btn' },
                        scope: { id: String(mainScopeNodeId), kind: 'region' },
                    },
                },
                resolvePolicy: {
                    preferDirect: true,
                    preferScoped: true,
                    requireVisible: true,
                },
            },
        };

        const replay = await replayRecording({
            ...createReplayStepContext(runner),
            steps: [step],
            enrichments,
            stopOnError: true,
        });

        expect(replay.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-clicked', 'main');
        await expect(page.locator('#result')).toHaveText('main');
        expect(await page.locator('body').getAttribute('data-clicked')).not.toBe('sidebar');

        await context.close();
    });

    test('scenario 5: fill recovers from broken primary selector via candidate fallback', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(`${fixtureURL}/drift_fill_v1.html`);
        await page.goto(`${fixtureURL}/drift_fill_v2.html`);
        const runner = await setupStepRunner(page, 'drift-fill-token');

        const step: StepUnion = {
            id: 'drift-fill-step',
            name: 'browser.fill',
            args: { value: 'alice-v2', nodeId: 'stale-node-id-fill' },
            meta: { source: 'record', ts: Date.now(), tabName: runner.tabName, tabId: runner.tabId },
        };

        const enrichments: RecordingEnhancementMap = {
            'drift-fill-step': {
                version: 1,
                eventType: 'input',
                resolveHint: {
                    raw: {
                        selector: '[data-testid=\"name-input\"]',
                        locatorCandidates: [{ kind: 'css', selector: '[data-testid=\"name-input\"]' }],
                    },
                },
                resolvePolicy: { requireVisible: true },
            },
        };

        const replay = await replayRecording({
            ...createReplayStepContext(runner),
            steps: [step],
            enrichments,
            stopOnError: true,
        });

        expect(replay.ok).toBe(true);
        await expect(page.locator('body')).toHaveAttribute('data-filled', 'alice-v2');
        await expect(page.locator('#value')).toHaveText('alice-v2');

        await context.close();
    });

    test('scenario 6: true ambiguity must fail conservatively', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();

        await page.goto(`${fixtureURL}/drift_ambiguous_v1.html`);
        await page.goto(`${fixtureURL}/drift_ambiguous_v2.html`);
        const runner = await setupStepRunner(page, 'drift-ambiguous-token');

        const step: StepUnion = {
            id: 'drift-ambiguous-delete',
            name: 'browser.click',
            args: { nodeId: 'stale-node-id-ambiguous' },
            meta: { source: 'record', ts: Date.now(), tabName: runner.tabName, tabId: runner.tabId },
        };

        const enrichments: RecordingEnhancementMap = {
            'drift-ambiguous-delete': {
                version: 1,
                eventType: 'click',
                resolveHint: {
                    target: { role: 'button', name: '删除', text: '删除' },
                },
                resolvePolicy: {
                    allowFuzzy: false,
                },
            },
        };

        const replay = await replayRecording({
            ...createReplayStepContext(runner),
            steps: [step],
            enrichments,
            stopOnError: true,
        });

        expect(replay.ok).toBe(false);
        const failed = replay.results.find((item) => !item.ok);
        expect(failed).toBeTruthy();
        expect((failed?.error as any)?.code).toBe('ERR_NOT_FOUND');
        await expect(page.locator('body')).toHaveAttribute('data-deleted', '');

        await context.close();
    });
});
