import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { executeBrowserEntity } from '../../../src/runner/steps/executors/entity';
import { executeBrowserQuery } from '../../../src/runner/steps/executors/query';
import type { Step } from '../../../src/runner/steps/types';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const createDeps = (): RunStepsDeps => {
    const workspaceName = 'ws-entity';
    const tabId = 'tab-entity';
    const tabName = 'tab-token-entity';
    const url = 'https://example.test/entity';

    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerOperation: UnifiedNode = { id: 'header_operation', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerOperation] };
    const approveBtn: UnifiedNode = { id: 'approve_btn_1', role: 'button', name: '审核', children: [] };
    const cellOrderNo: UnifiedNode = { id: 'cell_order_no_1', role: 'cell', name: 'SO-001', children: [] };
    const cellOperation: UnifiedNode = { id: 'cell_operation_1', role: 'cell', children: [approveBtn] };
    const row1: UnifiedNode = { id: 'row_1', role: 'row', children: [cellOrderNo, cellOperation] };
    const table: UnifiedNode = { id: 'table_1', role: 'table', children: [headerRow, row1] };

    const inputNode: UnifiedNode = { id: 'order_no_input', role: 'textbox', name: '订单编号', children: [] };
    const submitBtn: UnifiedNode = { id: 'submit_btn', role: 'button', name: '提交', children: [] };
    const form: UnifiedNode = { id: 'form_1', role: 'form', name: '订单表单', children: [inputNode, submitBtn] };
    const panel: UnifiedNode = { id: 'panel_1', role: 'region', name: '辅助面板', children: [] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table, form, panel] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: { id: 'ent_table', type: 'region', kind: 'table', nodeId: 'table_1' },
            ent_form: { id: 'ent_form', type: 'region', kind: 'form', nodeId: 'form_1' },
        },
        byNodeId: {
            table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            form_1: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
        },
    };
    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {
            order_no_input: { origin: { primaryDomId: '501' } },
            submit_btn: { origin: { primaryDomId: '502' } },
            approve_btn_1: { origin: { primaryDomId: '503' } },
        },
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: {
            byRuleId: {},
            byEntityId: {
                ent_table: {
                    businessTag: 'order.table.main',
                    primaryKey: { fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation' },
                    columns: [
                        { fieldKey: 'orderNo', name: '订单编号', kind: 'text', source: 'annotation' },
                        {
                            fieldKey: 'operation',
                            name: '操作',
                            kind: 'action_column',
                            source: 'annotation',
                            actions: [{ actionIntent: 'approve', text: '审核' }],
                        },
                    ],
                },
                ent_form: {
                    businessTag: 'order.form.main',
                    formFields: [{ fieldKey: 'orderNo', kind: 'input', controlNodeId: 'order_no_input' }],
                    formActions: [{ actionIntent: 'submit', nodeId: 'submit_btn' }],
                },
            },
            nodeHintsByNodeId: {},
        },
    });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });

    const snapshotSessionStore = {
        version: 1,
        entries: {
            [`${workspaceName}:${tabName}`]: {
                pageIdentity: { workspaceName, tabId, tabName, url },
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
    };

    const binding = {
        workspaceName,
        tabId,
        tabName,
        page: { url: () => url },
        traceCtx: { cache: { snapshotSessionStore } },
    };

    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: getRunnerConfig(),
        pluginHost: new RunnerPluginHost(path.resolve(process.cwd(), 'src/runner/plugin_entry.ts')),
    };
};

test('executeBrowserQuery supports op=entity and op=entity.target', async () => {
    const deps = createDeps();
    const queryStep: Step<'browser.query'> = {
        id: 'qe-1',
        name: 'browser.query',
        args: {
            op: 'entity',
            businessTag: 'order.table.main',
            query: 'table.rowCount',
        },
    };

    const queryResult = await executeBrowserQuery(queryStep, deps, 'ws-entity');
    assert.equal(queryResult.ok, true);
    assert.equal((queryResult.data as { kind: string }).kind, 'value');
    assert.equal((queryResult.data as { value: number }).value, 1);
    assert.equal((queryResult.data as { meta?: { businessTag?: string } }).meta?.businessTag, 'order.table.main');

    const targetStep: Step<'browser.query'> = {
        id: 'rt-1',
        name: 'browser.query',
        args: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {
                kind: 'table.row_action',
                primaryKey: {
                    fieldKey: 'orderNo',
                    value: 'SO-001',
                },
                actionIntent: 'approve',
            },
        },
    };

    const targetResult = await executeBrowserQuery(targetStep, deps, 'ws-entity');
    assert.equal(targetResult.ok, true);
    assert.equal((targetResult.data as { kind: string }).kind, 'nodeId');
    assert.equal((targetResult.data as { nodeId: string }).nodeId, 'approve_btn_1');
    assert.equal((targetResult.data as { meta?: { targetKind?: string } }).meta?.targetKind, 'table.row_action');
});

test('executeBrowserEntity supports list/find/get', async () => {
    const deps = createDeps();
    const listStep: Step<'browser.entity'> = {
        id: 'ent-list',
        name: 'browser.entity',
        args: { op: 'list' },
    };
    const listResult = await executeBrowserEntity(listStep, deps, 'ws-entity');
    assert.equal(listResult.ok, true);
    assert.equal((listResult.data as { total: number }).total, 2);

    const findStep: Step<'browser.entity'> = {
        id: 'ent-find',
        name: 'browser.entity',
        args: { op: 'find', kind: 'table', businessTag: 'order.table.main' },
    };
    const findResult = await executeBrowserEntity(findStep, deps, 'ws-entity');
    assert.equal(findResult.ok, true);
    assert.equal((findResult.data as { total: number }).total, 1);

    const getStep: Step<'browser.entity'> = {
        id: 'ent-get',
        name: 'browser.entity',
        args: { op: 'get', nodeId: 'table_1' },
    };
    const getResult = await executeBrowserEntity(getStep, deps, 'ws-entity');
    assert.equal(getResult.ok, true);
    assert.equal((getResult.data as { total: number }).total, 1);
    assert.equal(Boolean((getResult.data as { table_meta?: unknown }).table_meta), true);
});

test('executeBrowserEntity supports add/delete/rename', async () => {
    const deps = createDeps();

    const addStep: Step<'browser.entity'> = {
        id: 'ent-add',
        name: 'browser.entity',
        args: { op: 'add', nodeId: 'panel_1', kind: 'panel', name: '人工面板', businessTag: 'manual.panel' },
    };
    const addResult = await executeBrowserEntity(addStep, deps, 'ws-entity');
    assert.equal(addResult.ok, true);
    assert.equal((addResult.data as { entity?: { kind: string } }).entity?.kind, 'panel');

    const deleteStep: Step<'browser.entity'> = {
        id: 'ent-delete',
        name: 'browser.entity',
        args: { op: 'delete', nodeId: 'panel_1', kind: 'panel', businessTag: 'manual.panel' },
    };
    const deleteResult = await executeBrowserEntity(deleteStep, deps, 'ws-entity');
    assert.equal(deleteResult.ok, true);
    assert.equal((deleteResult.data as { deleted_count: number }).deleted_count, 1);

    const renameStep: Step<'browser.entity'> = {
        id: 'ent-rename',
        name: 'browser.entity',
        args: { op: 'rename', nodeId: 'table_1', name: '订单表格重命名' },
    };
    const renameResult = await executeBrowserEntity(renameStep, deps, 'ws-entity');
    assert.equal(renameResult.ok, true);
    assert.equal((renameResult.data as { name: string }).name, '订单表格重命名');
});

test('executeBrowserEntity returns expected errors', async () => {
    const deps = createDeps();

    const badOp = await executeBrowserEntity(
        {
            id: 'ent-bad-op',
            name: 'browser.entity',
            args: { op: 'unsupported' } as any,
        } as Step<'browser.entity'>,
        deps,
        'ws-entity',
    );
    assert.equal(badOp.ok, false);
    assert.equal(badOp.error?.code, 'ERR_BAD_ARGS');

    const badGet = await executeBrowserEntity(
        {
            id: 'ent-bad-get',
            name: 'browser.entity',
            args: { op: 'get', nodeId: '' },
        },
        deps,
        'ws-entity',
    );
    assert.equal(badGet.ok, false);
    assert.equal(badGet.error?.code, 'ERR_BAD_ARGS');

    const missingNode = await executeBrowserEntity(
        {
            id: 'ent-missing-node',
            name: 'browser.entity',
            args: { op: 'get', nodeId: 'missing-node' },
        },
        deps,
        'ws-entity',
    );
    assert.equal(missingNode.ok, false);
    assert.equal(missingNode.error?.code, 'ERR_NOT_FOUND');
});
