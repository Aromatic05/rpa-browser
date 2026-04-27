import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { chromium, type Page } from 'playwright';
import { getRunnerConfig } from '../../../src/config';
import { validateEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/validate';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { runStepList } from '../../../src/runner/run_steps';
import { executeBrowserQuery } from '../../../src/runner/steps/executors/query';
import { getNodeSemanticHints, setNodeAttr } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { applyBusinessEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import type {
    EntityIndex,
    FinalEntityView,
    SnapshotResult,
    UnifiedNode,
} from '../../../src/runner/steps/executors/snapshot/core/types';
import type { NormalizedEntityRuleBundle } from '../../../src/runner/steps/executors/snapshot/entity_rules/types';
import type { Step, StepUnion } from '../../../src/runner/steps/types';
import { createEntityRuleFixtureRoot } from '../../entity_rules/profile_fixture';
import { startMockApp } from '../../entity_rules/verify/helper';
import { setupStepRunner } from '../../helpers/steps';

type PaginationFixtureOptions = {
    disabledNext?: boolean;
    missingNext?: boolean;
    ambiguousNext?: boolean;
};

type ExecutorSpy = {
    clickNodeIds: string[];
};

const createDeps = (snapshot: SnapshotResult, finalEntityView: FinalEntityView): RunStepsDeps => {
    const workspaceId = 'ws-pagination';
    const tabId = 'tab-pagination';
    const tabToken = 'tab-token-pagination';
    const url = 'https://example.test/entity-pagination';
    const binding = {
        workspaceId,
        tabId,
        tabToken,
        page: { url: () => url },
        traceCtx: {
            cache: {
                snapshotSessionStore: {
                    version: 1,
                    entries: {
                        [`${workspaceId}:${tabToken}`]: {
                            pageIdentity: { workspaceId, tabId, tabToken, url },
                            baseSnapshot: snapshot,
                            finalSnapshot: snapshot,
                            finalEntityView,
                            overlays: { renamedNodes: {}, addedEntities: [], deletedEntities: [] },
                            diffBaselines: {},
                            dirty: false,
                            lastRefreshAt: Date.now(),
                            version: 1,
                        },
                    },
                },
            },
        },
    };

    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
    };
};

const createPaginationFixture = (
    options: PaginationFixtureOptions = {},
): {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
    root: UnifiedNode;
} => {
    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerAction: UnifiedNode = { id: 'header_action', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerAction] };
    const orderCell: UnifiedNode = { id: 'cell_order_1', role: 'cell', name: 'ORD-2026-001', children: [] };
    const editButton: UnifiedNode = { id: 'edit_button_1', role: 'button', name: '编辑', children: [] };
    const actionCell: UnifiedNode = { id: 'cell_action_1', role: 'cell', children: [editButton] };
    const row: UnifiedNode = { id: 'row_1', role: 'row', children: [orderCell, actionCell] };

    const nextButton: UnifiedNode = { id: 'pager_next', role: 'button', name: '下一页', children: [] };
    const nextButtonAlt: UnifiedNode = { id: 'pager_next_alt', role: 'button', name: '下一页备选', children: [] };
    const paginationChildren = options.ambiguousNext ? [nextButton, nextButtonAlt] : [nextButton];
    const pagination: UnifiedNode = { id: 'pagination', role: 'navigation', name: 'Pagination', children: paginationChildren };
    const tableChildren = options.missingNext ? [headerRow, row] : [headerRow, row, pagination];
    const table: UnifiedNode = { id: 'table_main', role: 'table', name: '订单列表', children: tableChildren };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };

    setNodeAttr(table, 'class', 'ant-table');
    setNodeAttr(pagination, 'class', 'ant-pagination ant-table-pagination ant-table-pagination-end');
    setNodeAttr(nextButton, 'class', options.disabledNext ? 'ant-pagination-next ant-pagination-disabled' : 'ant-pagination-next');
    setNodeAttr(nextButtonAlt, 'class', 'ant-pagination-next');
    setNodeAttr(editButton, 'class', 'ant-btn');

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: {
                id: 'ent_table',
                type: 'region',
                kind: 'table',
                nodeId: 'table_main',
                name: '订单列表',
            },
        },
        byNodeId: {
            table_main: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            row_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            cell_order_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            cell_action_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            edit_button_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            pagination: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            pager_next: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
            pager_next_alt: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
        },
    };

    const bundle: NormalizedEntityRuleBundle = {
        id: 'pagination-profile',
        page: { kind: 'table' },
        matchRules: [
            {
                ruleId: 'order_list_main',
                source: 'region',
                expect: 'unique',
                order: 0,
                match: {
                    kind: 'table',
                    nameContains: '订单列表',
                },
            },
            {
                ruleId: 'order_action_edit',
                source: 'node',
                expect: 'unique',
                order: 1,
                within: 'order_list_main',
                match: {
                    textContains: '编辑',
                },
            },
            {
                ruleId: 'order_table_next_page',
                source: 'node',
                expect: options.ambiguousNext ? 'one_or_more' : 'unique',
                order: 2,
                within: 'order_list_main',
                match: {
                    relation: 'pagination',
                    classContains: 'ant-pagination-next',
                },
            },
        ],
        annotationByRuleId: {
            order_list_main: {
                ruleId: 'order_list_main',
                businessTag: 'order.list.main',
                primaryKey: {
                    fieldKey: 'orderNo',
                    columns: ['订单编号'],
                    source: 'annotation',
                },
                pagination: {
                    nextAction: {
                        actionIntent: 'nextPage',
                        nodeRuleId: 'order_table_next_page',
                    },
                },
                columns: [
                    {
                        fieldKey: 'orderNo',
                        name: '订单编号',
                        kind: 'text',
                        source: 'annotation',
                    },
                    {
                        fieldKey: 'operation',
                        name: '操作',
                        kind: 'action_column',
                        source: 'annotation',
                        actions: [{ actionIntent: 'edit', text: '编辑' }],
                    },
                ],
            },
        },
    };

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const overlay = applyBusinessEntityRules({
        root,
        entityIndex,
        bundle,
    });
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {
            pager_next: { origin: { primaryDomId: 'dom-next' } },
            pager_next_alt: { origin: { primaryDomId: 'dom-next-alt' } },
            edit_button_1: { origin: { primaryDomId: 'dom-edit' } },
        },
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: overlay,
    });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });

    return { snapshot, finalEntityView, root };
};

const buildValidRawRules = () => ({
    matchRaw: {
        version: 1,
        page: { kind: 'table' },
        entities: [
            {
                ruleId: 'order_list_main',
                source: 'region',
                expect: 'unique',
                match: { kind: 'table' },
            },
            {
                ruleId: 'order_table_next_page',
                source: 'node',
                expect: 'unique',
                within: 'order_list_main',
                match: { relation: 'pagination', classContains: 'ant-pagination-next' },
            },
        ],
    },
    annotationRaw: {
        version: 1,
        page: { kind: 'table' },
        annotations: [
            {
                ruleId: 'order_list_main',
                businessTag: 'order.list.main',
                pagination: {
                    nextAction: {
                        actionIntent: 'nextPage',
                        nodeRuleId: 'order_table_next_page',
                    },
                },
                columns: [{ fieldKey: 'orderNo', name: '订单编号' }],
            },
        ],
    },
});

const buildSpyDeps = (deps: RunStepsDeps, spy: ExecutorSpy): RunStepsDeps => ({
    ...deps,
    pluginHost: {
        ...deps.pluginHost,
        getExecutors: () => {
            const executors = deps.pluginHost.getExecutors();
            return {
                ...executors,
                'browser.click': async (step: StepUnion, innerDeps: RunStepsDeps, workspaceId: string) => {
                    spy.clickNodeIds.push(String((step.args as { nodeId?: unknown }).nodeId || ''));
                    return await executors['browser.click'](step, innerDeps, workspaceId);
                },
            };
        },
    } as any,
});

const withAntEntityRuleRunner = async <T>(
    callback: (ctx: {
        page: Page;
        workspaceId: string;
        deps: RunStepsDeps;
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
            profiles: ['oa-ant-orders'],
            strict: true,
        };

        await page.goto(`${mockServer.baseUrl}/entity-rules/fixtures/order-list`, { waitUntil: 'domcontentloaded' });

        return await callback({
            page,
            workspaceId: runner.workspaceId,
            deps: runner.deps,
        });
    } finally {
        await fixture.cleanup();
        await browser.close();
        await mockServer.close();
    }
};

test('schema validates table pagination annotation', () => {
    const { matchRaw, annotationRaw } = buildValidRawRules();
    const result = validateEntityRules('pagination-profile', matchRaw, annotationRaw);
    assert.equal(result.ok, true);
});

test('schema rejects pagination nextAction rule refs that do not exist', () => {
    const { matchRaw, annotationRaw } = buildValidRawRules();
    const result = validateEntityRules('pagination-profile', matchRaw, {
        ...annotationRaw,
        annotations: [
            {
                ...annotationRaw.annotations[0],
                pagination: {
                    nextAction: {
                        actionIntent: 'nextPage',
                        nodeRuleId: 'missing_next_rule',
                    },
                },
            },
        ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.includes('pagination.nextAction.nodeRuleId not found')), true);
});

test('schema rejects pagination on non-table annotations', () => {
    const { matchRaw, annotationRaw } = buildValidRawRules();
    const result = validateEntityRules(
        'pagination-profile',
        {
            ...matchRaw,
            page: { kind: 'form' },
            entities: [
                { ruleId: 'order_form_main', source: 'region', expect: 'unique', match: { kind: 'form' } },
                matchRaw.entities[1],
            ],
        },
        {
            ...annotationRaw,
            page: { kind: 'form' },
            annotations: [
                {
                    ...annotationRaw.annotations[0],
                    ruleId: 'order_form_main',
                },
            ],
        },
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.includes('pagination only allowed for table annotations')), true);
});

test('apply resolves table pagination nextAction binding and semantic hints', () => {
    const { finalEntityView, root } = createPaginationFixture();
    const table = finalEntityView.entities.find((entity) => entity.businessTag === 'order.list.main');

    assert.ok(table);
    assert.equal(table?.pagination?.nextAction?.nodeId, 'pager_next');
    assert.equal(table?.pagination?.nextAction?.actionIntent, 'nextPage');

    const semantic = getNodeSemanticHints(root.children[0].children[2].children[0]);
    assert.equal(semantic?.actionIntent, 'nextPage');
    assert.equal(semantic?.actionRole, 'pagination.next');
    assert.equal(semantic?.entityKind, 'table');
});

test('browser.query table.hasNextPage reports enabled next page state', async () => {
    const { snapshot, finalEntityView } = createPaginationFixture();
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'has-next',
        name: 'browser.query',
        args: {
            op: 'entity',
            businessTag: 'order.list.main',
            query: 'table.hasNextPage',
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-pagination');
    assert.equal(result.ok, true);
    assert.equal(result.data?.kind, 'value');
    assert.equal(result.data?.value, true);
    assert.equal(result.data?.meta?.query, 'table.hasNextPage');
    assert.equal(result.data?.meta?.targetNodeId, 'pager_next');
    assert.equal(result.data?.meta?.reason, 'nextActionEnabled');
});

test('browser.query table.hasNextPage reports disabled next page state', async () => {
    const { snapshot, finalEntityView } = createPaginationFixture({ disabledNext: true });
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'has-next-disabled',
        name: 'browser.query',
        args: {
            op: 'entity',
            businessTag: 'order.list.main',
            query: 'table.hasNextPage',
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-pagination');
    assert.equal(result.ok, true);
    assert.equal(result.data?.kind, 'value');
    assert.equal(result.data?.value, false);
    assert.equal(result.data?.meta?.reason, 'nextActionDisabled');
});

test('browser.query table.nextPageTarget resolves enabled next page node', async () => {
    const { snapshot, finalEntityView } = createPaginationFixture();
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'next-target',
        name: 'browser.query',
        args: {
            op: 'entity',
            businessTag: 'order.list.main',
            query: 'table.nextPageTarget',
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-pagination');
    assert.equal(result.ok, true);
    assert.equal(result.data?.kind, 'nodeId');
    assert.equal(result.data?.nodeId, 'pager_next');
    assert.equal(result.data?.meta?.targetKind, 'table.nextPage');
    assert.equal(result.data?.meta?.actionIntent, 'nextPage');
});

test('browser.query table.nextPageTarget rejects disabled next page node', async () => {
    const { snapshot, finalEntityView } = createPaginationFixture({ disabledNext: true });
    const deps = createDeps(snapshot, finalEntityView);
    const step: Step<'browser.query'> = {
        id: 'next-target-disabled',
        name: 'browser.query',
        args: {
            op: 'entity',
            businessTag: 'order.list.main',
            query: 'table.nextPageTarget',
        },
    };

    const result = await executeBrowserQuery(step, deps, 'ws-pagination');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_UNRESOLVED_TARGET');
    assert.equal((result.error?.details as { reason?: string })?.reason, 'nextActionDisabled');
});

test('diagnostics capture unresolved and ambiguous table pagination bindings', () => {
    const unresolved = createPaginationFixture({ missingNext: true }).finalEntityView.diagnostics || [];
    const ambiguous = createPaginationFixture({ ambiguousNext: true }).finalEntityView.diagnostics || [];

    assert.equal(unresolved.some((item) => item.code === 'TABLE_PAGINATION_NEXT_UNRESOLVED'), true);
    assert.equal(ambiguous.some((item) => item.code === 'TABLE_PAGINATION_NEXT_AMBIGUOUS'), true);
});

test('order list pagination query can resolve next page target', async () => {
    await withAntEntityRuleRunner(async ({ page, workspaceId, deps }) => {
        const spy: ExecutorSpy = { clickNodeIds: [] };
        const spyDeps = buildSpyDeps(deps, spy);
        const steps: StepUnion[] = [
            {
                id: 'hasNext',
                name: 'browser.query',
                args: {
                    op: 'entity',
                    businessTag: 'order.list.main',
                    query: 'table.hasNextPage',
                },
            } as StepUnion,
            {
                id: 'page1Rows',
                name: 'browser.query',
                args: {
                    op: 'entity',
                    businessTag: 'order.list.main',
                    query: 'table.current_rows',
                },
            } as StepUnion,
            {
                id: 'nextTarget',
                name: 'browser.query',
                args: {
                    op: 'entity',
                    businessTag: 'order.list.main',
                    query: 'table.nextPageTarget',
                },
            } as StepUnion,
            {
                id: 'clickNext',
                name: 'browser.click',
                args: {
                    nodeId: '{{nextTarget.data.nodeId}}',
                },
            } as StepUnion,
            {
                id: 'page2Rows',
                name: 'browser.query',
                args: {
                    op: 'entity',
                    businessTag: 'order.list.main',
                    query: 'table.current_rows',
                },
            } as StepUnion,
        ];

        const { checkpoint, pipe } = await runStepList(workspaceId, steps, spyDeps, {
            runId: 'run-order-list-pagination',
            stopOnError: true,
        });
        const results = pipe.items as any[];

        assert.equal(checkpoint.status, 'completed');
        assert.equal(results[0].ok, true);
        assert.equal(results[0].data.kind, 'value');
        assert.equal(results[0].data.value, true);

        assert.equal(results[2].ok, true);
        assert.equal(results[2].data.kind, 'nodeId');
        assert.equal(typeof results[2].data.nodeId, 'string');
        assert.equal(results[2].data.nodeId.length > 0, true);

        assert.equal(results[3].ok, true);
        assert.equal(spy.clickNodeIds[0], results[2].data.nodeId);
        assert.equal(spy.clickNodeIds[0].includes('{{'), false);

        assert.equal(results[4].ok, true);
        assert.equal(results[4].data.kind, 'value');
        assert.notEqual(results[1].data.value[0].cells[0].text, results[4].data.value[0].cells[0].text);
        await page.getByText('ORD-2026-011').waitFor({ state: 'visible' });
    });
});
