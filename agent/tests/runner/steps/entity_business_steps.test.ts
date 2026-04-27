import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { executeBrowserQueryEntity } from '../../../src/runner/steps/executors/query_entity';
import { executeBrowserResolveEntityTarget } from '../../../src/runner/steps/executors/resolve_entity_target';
import type { Step } from '../../../src/runner/steps/types';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import { getRunnerConfig } from '../../../src/config';
import { RunnerPluginHost } from '../../../src/runner/hotreload/plugin_host';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const createDeps = (): RunStepsDeps => {
    const workspaceId = 'ws-entity';
    const tabId = 'tab-entity';
    const tabToken = 'tab-token-entity';
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
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table, form] };

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
    };

    const binding = {
        workspaceId,
        tabId,
        tabToken,
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

test('executeBrowserQueryEntity returns table row_count from fresh snapshot context', async () => {
    const deps = createDeps();
    const step: Step<'browser.query_entity'> = {
        id: 'qe-1',
        name: 'browser.query_entity',
        args: {
            businessTag: 'order.table.main',
            query: 'table.row_count',
        },
    };

    const result = await executeBrowserQueryEntity(step, deps, 'ws-entity');
    assert.equal(result.ok, true);
    assert.equal((result.data as { row_count: number }).row_count, 1);
});

test('executeBrowserResolveEntityTarget returns form field and table row action targets', async () => {
    const deps = createDeps();
    const formStep: Step<'browser.resolve_entity_target'> = {
        id: 'rt-1',
        name: 'browser.resolve_entity_target',
        args: {
            businessTag: 'order.form.main',
            target: {
                kind: 'form.field',
                fieldKey: 'orderNo',
            },
        },
    };
    const formResult = await executeBrowserResolveEntityTarget(formStep, deps, 'ws-entity');
    assert.equal(formResult.ok, true);
    assert.equal((formResult.data as { node_id: string }).node_id, 'order_no_input');

    const tableStep: Step<'browser.resolve_entity_target'> = {
        id: 'rt-2',
        name: 'browser.resolve_entity_target',
        args: {
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
    const tableResult = await executeBrowserResolveEntityTarget(tableStep, deps, 'ws-entity');
    assert.equal(tableResult.ok, true);
    assert.equal((tableResult.data as { node_id: string }).node_id, 'approve_btn_1');
});
