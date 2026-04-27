import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium } from 'playwright';
import { runStepList } from '../../../src/runner/run_steps';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';
import { createEntityRuleFixtureRoot } from '../../entity_rules/profile_fixture';
import { startMockApp } from '../../entity_rules/verify/helper';
import { setupStepRunner } from '../../helpers/steps';

type ExecutorSpy = {
    fillIds: string[];
    clickIds: string[];
    hoverIds: string[];
};

const buildSpyDeps = (deps: RunStepsDeps, spy: ExecutorSpy): RunStepsDeps => ({
    ...deps,
    pluginHost: {
        ...deps.pluginHost,
        getExecutors: () => {
            const executors = deps.pluginHost.getExecutors();
            return {
                ...executors,
                'browser.fill': async (step: StepUnion, innerDeps: RunStepsDeps, workspaceId: string) => {
                    spy.fillIds.push(String((step.args as { id?: unknown }).id || ''));
                    return await executors['browser.fill'](step, innerDeps, workspaceId);
                },
                'browser.click': async (step: StepUnion, innerDeps: RunStepsDeps, workspaceId: string) => {
                    spy.clickIds.push(String((step.args as { id?: unknown }).id || ''));
                    return await executors['browser.click'](step, innerDeps, workspaceId);
                },
                'browser.hover': async (step: StepUnion, innerDeps: RunStepsDeps, workspaceId: string) => {
                    spy.hoverIds.push(String((step.args as { id?: unknown }).id || ''));
                    return await executors['browser.hover'](step, innerDeps, workspaceId);
                },
            };
        },
    } as any,
});

const withAntEntityRuleRunner = async <T>(
    input: {
        profile: string;
        pagePath: string;
    },
    callback: (ctx: {
        page: Page;
        workspaceId: string;
        deps: RunStepsDeps;
        run: (steps: StepUnion[], opts?: { stopOnError?: boolean }) => Promise<{ checkpoint: { status: string }; results: any[] }>;
    }) => Promise<T>,
): Promise<T> => {
    const mockServer = await startMockApp('ant');
    const browser = await chromium.launch({
        headless: true,
        chromiumSandbox: false,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const fixture = await createEntityRuleFixtureRoot();

    try {
        const context = await browser.newContext();
        const page = await context.newPage();
        const runner = await setupStepRunner(page);

        runner.deps.config.entityRules = {
            ...runner.deps.config.entityRules,
            enabled: true,
            rootDir: fixture.rootDir,
            selection: 'explicit',
            profiles: [input.profile],
            strict: true,
        };

        await page.goto(`${mockServer.baseUrl}${input.pagePath}`, { waitUntil: 'domcontentloaded' });

        const run = async (steps: StepUnion[], opts?: { stopOnError?: boolean }) => {
            const { checkpoint, pipe } = await runStepList(runner.workspaceId, steps, runner.deps, {
                runId: `run-${path.basename(input.pagePath)}`,
                stopOnError: opts?.stopOnError ?? true,
            });
            return {
                checkpoint: { status: checkpoint.status },
                results: pipe.items,
            };
        };

        return await callback({
            page,
            workspaceId: runner.workspaceId,
            deps: runner.deps,
            run,
        });
    } finally {
        await fixture.cleanup();
        await browser.close();
        await mockServer.close();
    }
};

test('order form query target can fill field and click submit via result refs', async () => {
    await withAntEntityRuleRunner(
        {
            profile: 'oa-ant-order-form',
            pagePath: '/entity-rules/fixtures/order-form',
        },
        async ({ page, workspaceId, deps }) => {
            const spy: ExecutorSpy = { fillIds: [], clickIds: [], hoverIds: [] };
            const spyDeps = buildSpyDeps(deps, spy);
            const steps: StepUnion[] = [
                {
                    id: 'resolveBuyer',
                    name: 'browser.query',
                    args: {
                        op: 'entity.target',
                        businessTag: 'order.form.main',
                        target: {
                            kind: 'form.field',
                            fieldKey: 'buyer',
                        },
                    },
                } as StepUnion,
                {
                    id: 'fillBuyer',
                    name: 'browser.fill',
                    args: {
                        id: '{{resolveBuyer.data.nodeId}}',
                        value: '张三',
                    },
                } as StepUnion,
                {
                    id: 'resolveSubmit',
                    name: 'browser.query',
                    args: {
                        op: 'entity.target',
                        businessTag: 'order.form.main',
                        target: {
                            kind: 'form.action',
                            actionIntent: 'submit',
                        },
                    },
                } as StepUnion,
                {
                    id: 'clickSubmit',
                    name: 'browser.click',
                    args: {
                        id: '{{resolveSubmit.data.nodeId}}',
                    },
                } as StepUnion,
            ];

            const { checkpoint, pipe } = await runStepList(workspaceId, steps, spyDeps, {
                runId: 'run-order-form-query-action',
                stopOnError: true,
            });
            const results = pipe.items as any[];

            assert.equal(checkpoint.status, 'completed');
            assert.equal(results.length, 4);

            const resolveBuyer = results[0];
            assert.equal(resolveBuyer.ok, true);
            assert.equal(resolveBuyer.data.kind, 'nodeId');
            assert.equal(typeof resolveBuyer.data.nodeId, 'string');
            assert.equal(resolveBuyer.data.nodeId.length > 0, true);
            assert.equal(resolveBuyer.data.meta.businessTag, 'order.form.main');
            assert.equal(resolveBuyer.data.meta.targetKind, 'form.field');
            assert.equal(resolveBuyer.data.meta.fieldKey, 'buyer');

            const fillBuyer = results[1];
            assert.equal(fillBuyer.ok, true);
            assert.equal(spy.fillIds.length, 1);
            assert.equal(spy.fillIds[0], resolveBuyer.data.nodeId);
            assert.equal(spy.fillIds[0].includes('{{'), false);
            assert.equal(await page.locator('input[placeholder=\"请输入采购人\"]').inputValue(), '张三');

            const resolveSubmit = results[2];
            assert.equal(resolveSubmit.ok, true);
            assert.equal(resolveSubmit.data.kind, 'nodeId');
            assert.equal(typeof resolveSubmit.data.nodeId, 'string');
            assert.equal(resolveSubmit.data.nodeId.length > 0, true);
            assert.equal(resolveSubmit.data.meta.targetKind, 'form.action');
            assert.equal(resolveSubmit.data.meta.actionIntent, 'submit');

            const clickSubmit = results[3];
            assert.equal(clickSubmit.ok, true);
            assert.equal(spy.clickIds.length, 1);
            assert.equal(spy.clickIds[0], resolveSubmit.data.nodeId);
            assert.equal(spy.clickIds[0].includes('{{'), false);
        },
    );
});

test('order list query can resolve row action and click via result refs', async () => {
    await withAntEntityRuleRunner(
        {
            profile: 'oa-ant-orders',
            pagePath: '/entity-rules/fixtures/order-list',
        },
        async ({ page, workspaceId, deps }) => {
            const spy: ExecutorSpy = { fillIds: [], clickIds: [], hoverIds: [] };
            const spyDeps = buildSpyDeps(deps, spy);
            const steps: StepUnion[] = [
                {
                    id: 'rowCount',
                    name: 'browser.query',
                    args: {
                        op: 'entity',
                        businessTag: 'order.list.main',
                        query: 'table.row_count',
                    },
                } as StepUnion,
                {
                    id: 'currentRows',
                    name: 'browser.query',
                    args: {
                        op: 'entity',
                        businessTag: 'order.list.main',
                        query: 'table.current_rows',
                    },
                } as StepUnion,
                {
                    id: 'resolveEdit',
                    name: 'browser.query',
                    args: {
                        op: 'entity.target',
                        businessTag: 'order.list.main',
                        target: {
                            kind: 'table.row_action',
                            primaryKey: {
                                fieldKey: 'orderNo',
                                value: 'ORD-2026-001',
                            },
                            actionIntent: 'edit',
                        },
                    },
                } as StepUnion,
                {
                    id: 'clickEdit',
                    name: 'browser.click',
                    args: {
                        id: '{{resolveEdit.data.nodeId}}',
                    },
                } as StepUnion,
            ];

            const { checkpoint, pipe } = await runStepList(workspaceId, steps, spyDeps, {
                runId: 'run-order-list-query-action',
                stopOnError: true,
            });
            const results = pipe.items as any[];

            assert.equal(checkpoint.status, 'completed');
            assert.equal(results.length, 4);

            const rowCount = results[0];
            assert.equal(rowCount.ok, true);
            assert.equal(rowCount.data.kind, 'value');
            assert.equal(typeof rowCount.data.value, 'number');
            assert.equal(rowCount.data.value > 0, true);

            const currentRows = results[1];
            assert.equal(currentRows.ok, true);
            assert.equal(currentRows.data.kind, 'value');
            assert.equal(Array.isArray(currentRows.data.value), true);
            assert.equal(currentRows.data.value.length, rowCount.data.value);
            assert.equal(currentRows.data.value.length > 0, true);
            assert.equal(typeof currentRows.data.value[0].rowNodeId, 'string');
            assert.equal(Array.isArray(currentRows.data.value[0].cells), true);
            assert.equal(typeof currentRows.data.value[0].cells[0].fieldKey, 'string');
            assert.equal(typeof currentRows.data.value[0].cells[0].header, 'string');
            assert.equal(typeof currentRows.data.value[0].cells[0].text, 'string');
            assert.equal(typeof currentRows.data.value[0].cells[0].cellNodeId, 'string');

            const resolveEdit = results[2];
            assert.equal(resolveEdit.ok, true);
            assert.equal(resolveEdit.data.kind, 'nodeId');
            assert.equal(typeof resolveEdit.data.nodeId, 'string');
            assert.equal(resolveEdit.data.nodeId.length > 0, true);
            assert.equal(resolveEdit.data.meta.targetKind, 'table.row_action');
            assert.equal(typeof resolveEdit.data.meta.rowNodeId, 'string');
            assert.equal(typeof resolveEdit.data.meta.cellNodeId, 'string');
            assert.equal(resolveEdit.data.meta.actionIntent, 'edit');
            assert.deepEqual(resolveEdit.data.meta.primaryKey, {
                fieldKey: 'orderNo',
                value: 'ORD-2026-001',
            });

            const clickEdit = results[3];
            assert.equal(clickEdit.ok, true);
            assert.equal(spy.clickIds.length, 1);
            assert.equal(spy.clickIds[0], resolveEdit.data.nodeId);
            assert.equal(spy.clickIds[0].includes('{{'), false);
            await page.getByRole('dialog').waitFor({ state: 'visible' });
            await page.getByText('订单编号：ORD-2026-001').waitFor({ state: 'visible' });
        },
    );
});

test('browser.query nodeIds result refs can drive hover actions', async () => {
    await withAntEntityRuleRunner(
        {
            profile: 'oa-ant-orders',
            pagePath: '/entity-rules/fixtures/order-list',
        },
        async ({ workspaceId, deps }) => {
            const spy: ExecutorSpy = { fillIds: [], clickIds: [], hoverIds: [] };
            const spyDeps = buildSpyDeps(deps, spy);
            const steps: StepUnion[] = [
                {
                    id: 'snapshot',
                    name: 'browser.snapshot',
                    args: {
                        includeA11y: true,
                    },
                } as StepUnion,
                {
                    id: 'buttons',
                    name: 'browser.query',
                    args: {
                        from: 'snapshot',
                        where: {
                            role: 'button',
                        },
                        limit: 5,
                    },
                } as StepUnion,
                {
                    id: 'hoverFirstButton',
                    name: 'browser.hover',
                    args: {
                        id: '{{buttons.data.nodeIds.0}}',
                    },
                } as StepUnion,
            ];

            const { checkpoint, pipe } = await runStepList(workspaceId, steps, spyDeps, {
                runId: 'run-browser-query-hover',
                stopOnError: true,
            });
            const results = pipe.items as any[];

            assert.equal(checkpoint.status, 'completed');
            assert.equal(results[1].data.kind, 'nodeIds');
            assert.equal(results[1].data.nodeIds.length > 0, true);
            assert.equal(results[2].ok, true);
            assert.equal(spy.hoverIds.length, 1);
            assert.equal(spy.hoverIds[0], results[1].data.nodeIds[0]);
            assert.equal(spy.hoverIds[0].includes('{{'), false);
        },
    );
});

test('browser.compute can consume entity query envelope value refs', async () => {
    await withAntEntityRuleRunner(
        {
            profile: 'oa-ant-orders',
            pagePath: '/entity-rules/fixtures/order-list',
        },
        async ({ workspaceId, deps }) => {
            const steps: StepUnion[] = [
                {
                    id: 'rowCount',
                    name: 'browser.query',
                    args: {
                        op: 'entity',
                        businessTag: 'order.list.main',
                        query: 'table.row_count',
                    },
                } as StepUnion,
                {
                    id: 'hasRows',
                    name: 'browser.compute',
                    args: {
                        expr: {
                            op: 'exists',
                            args: [
                                { ref: { path: 'steps.rowCount.data.value' } },
                            ],
                        },
                    },
                } as StepUnion,
            ];

            const { checkpoint, pipe } = await runStepList(workspaceId, steps, deps, {
                runId: 'run-query-compute-envelope',
                stopOnError: true,
            });
            const results = pipe.items as any[];

            assert.equal(checkpoint.status, 'completed');
            assert.equal(results[0].ok, true);
            assert.equal(results[0].data.kind, 'value');
            assert.equal(results[1].ok, true);
            assert.equal(results[1].data.value, true);
        },
    );
});
