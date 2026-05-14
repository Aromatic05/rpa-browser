import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import {
    queryBusinessEntity,
    resolveBusinessEntityTarget,
} from '../../../src/runner/steps/executors/snapshot/core/business_entity_resolver';
import type { EntityIndex, FinalEntityView, SnapshotResult, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const createFixture = (): {
    snapshot: SnapshotResult;
    finalEntityView: FinalEntityView;
} => {
    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerBuyer: UnifiedNode = { id: 'header_buyer', role: 'columnheader', name: '采购人', children: [] };
    const headerOperation: UnifiedNode = { id: 'header_operation', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerBuyer, headerOperation] };

    const approveBtn1: UnifiedNode = { id: 'approve_btn_1', role: 'button', name: '审核', children: [] };
    const cellOrderNo1: UnifiedNode = { id: 'cell_order_no_1', role: 'cell', name: 'SO-001', children: [] };
    const cellBuyer1: UnifiedNode = { id: 'cell_buyer_1', role: 'cell', name: 'Alice', children: [] };
    const cellOperation1: UnifiedNode = { id: 'cell_operation_1', role: 'cell', children: [approveBtn1] };
    const row1: UnifiedNode = { id: 'row_1', role: 'row', children: [cellOrderNo1, cellBuyer1, cellOperation1] };

    const approveBtn2: UnifiedNode = { id: 'approve_btn_2', role: 'button', name: '审核', children: [] };
    const cellOrderNo2: UnifiedNode = { id: 'cell_order_no_2', role: 'cell', name: 'SO-002', children: [] };
    const cellBuyer2: UnifiedNode = { id: 'cell_buyer_2', role: 'cell', name: 'Bob', children: [] };
    const cellOperation2: UnifiedNode = { id: 'cell_operation_2', role: 'cell', children: [approveBtn2] };
    const row2: UnifiedNode = { id: 'row_2', role: 'row', children: [cellOrderNo2, cellBuyer2, cellOperation2] };

    const table: UnifiedNode = { id: 'table_1', role: 'table', name: '订单列表', children: [headerRow, row1, row2] };

    const orderNoLabel: UnifiedNode = { id: 'order_no_label', role: 'text', name: '订单编号', children: [] };
    const orderNoInput: UnifiedNode = { id: 'order_no_input', role: 'textbox', name: '订单编号输入', children: [] };
    const submitBtn: UnifiedNode = { id: 'submit_btn', role: 'button', name: '提交', children: [] };
    const form: UnifiedNode = { id: 'form_1', role: 'form', name: '订单表单', children: [orderNoLabel, orderNoInput, submitBtn] };

    const root: UnifiedNode = { id: 'root', role: 'root', children: [table, form] };
    const entityIndex: EntityIndex = {
        entities: {
            ent_table: { id: 'ent_table', type: 'region', kind: 'table', nodeId: 'table_1', name: '订单列表' },
            ent_form: { id: 'ent_form', type: 'region', kind: 'form', nodeId: 'form_1', name: '订单表单' },
        },
        byNodeId: {
            table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            form_1: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
            order_no_input: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            order_no_label: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            submit_btn: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
        },
    };

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {
            order_no_input: { origin: { primaryDomId: '201' } },
            submit_btn: { origin: { primaryDomId: '202' } },
            approve_btn_1: { origin: { primaryDomId: '203' } },
        },
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: {
            byRuleId: {},
            byEntityId: {
                ent_table: {
                    businessTag: 'order.table.main',
                    businessName: '订单列表',
                    primaryKey: { fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation' },
                    columns: [
                        { fieldKey: 'orderNo', name: '订单编号', kind: 'text', source: 'annotation' },
                        { fieldKey: 'buyer', name: '采购人', kind: 'text', source: 'annotation' },
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
                    businessName: '订单表单',
                    formFields: [
                        {
                            fieldKey: 'orderNo',
                            name: '订单编号',
                            kind: 'input',
                            controlNodeId: 'order_no_input',
                            labelNodeId: 'order_no_label',
                        },
                    ],
                    formActions: [{ actionIntent: 'submit', text: '提交', nodeId: 'submit_btn' }],
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

    return { snapshot, finalEntityView };
};

test('queryBusinessEntity table and form queries return expected shapes', () => {
    const { snapshot, finalEntityView } = createFixture();

    const rowCount = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.rowCount');
    assert.equal(rowCount.ok, true);
    if (rowCount.ok) {
        assert.equal(rowCount.data.kind, 'value');
        assert.equal(rowCount.data.value, 2);
        assert.equal((rowCount.data.meta as any).businessTag, 'order.table.main');
    }

    const headers = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.headers');
    assert.equal(headers.ok, true);
    if (headers.ok) {
        assert.equal(headers.data.kind, 'value');
        assert.deepEqual(headers.data.value, ['订单编号', '采购人', '操作']);
    }

    const pk = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.primaryKey');
    assert.equal(pk.ok, true);
    if (pk.ok) {
        assert.equal(pk.data.kind, 'value');
        assert.equal((pk.data.value as { fieldKey: string }).fieldKey, 'orderNo');
    }

    const columns = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.columns');
    assert.equal(columns.ok, true);
    if (columns.ok) {
        assert.equal(columns.data.kind, 'value');
        assert.equal(Array.isArray(columns.data.value), true);
        assert.equal((columns.data.value as Array<{ fieldKey: string }>).length, 3);
    }

    const rows = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.currentRows');
    assert.equal(rows.ok, true);
    if (rows.ok) {
        assert.equal(rows.data.kind, 'value');
        const firstRow = (rows.data.value as Array<{ rowNodeId: string; cells: Array<{ fieldKey: string }> }>)[0];
        assert.equal(firstRow.rowNodeId, 'row_1');
        assert.equal(firstRow.cells[0].fieldKey, 'orderNo');
    }

    const formFields = queryBusinessEntity(snapshot, finalEntityView, 'order.form.main', 'form.fields');
    assert.equal(formFields.ok, true);
    if (formFields.ok) {
        assert.equal(formFields.data.kind, 'value');
        assert.equal((formFields.data.value as Array<{ fieldKey: string }>)[0].fieldKey, 'orderNo');
    }

    const formActions = queryBusinessEntity(snapshot, finalEntityView, 'order.form.main', 'form.actions');
    assert.equal(formActions.ok, true);
    if (formActions.ok) {
        assert.equal(formActions.data.kind, 'value');
        assert.equal((formActions.data.value as Array<{ actionIntent: string }>)[0].actionIntent, 'submit');
    }
});

test('resolveBusinessEntityTarget resolves form and table targets', () => {
    const { snapshot, finalEntityView } = createFixture();

    const field = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.form.main', {
        kind: 'form.field',
        fieldKey: 'orderNo',
    });
    assert.equal(field.ok, true);
    if (field.ok) {
        assert.equal(field.data.kind, 'nodeId');
        assert.equal(field.data.nodeId, 'order_no_input');
        assert.equal((field.data.meta as any).targetKind, 'form.field');
    }

    const action = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.form.main', {
        kind: 'form.action',
        actionIntent: 'submit',
    });
    assert.equal(action.ok, true);
    if (action.ok) {
        assert.equal(action.data.kind, 'nodeId');
        assert.equal(action.data.nodeId, 'submit_btn');
    }

    const row = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'table.row',
        primaryKey: { fieldKey: 'orderNo', value: 'SO-001' },
    });
    assert.equal(row.ok, true);
    if (row.ok) {
        assert.equal(row.data.kind, 'nodeId');
        assert.equal(row.data.nodeId, 'row_1');
        assert.equal((row.data.meta as any).rowNodeId, 'row_1');
    }

    const rowAction = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'table.row_action',
        primaryKey: { fieldKey: 'orderNo', value: 'SO-001' },
        actionIntent: 'approve',
    });
    assert.equal(rowAction.ok, true);
    if (rowAction.ok) {
        assert.equal(rowAction.data.kind, 'nodeId');
        assert.equal(rowAction.data.nodeId, 'approve_btn_1');
        assert.equal((rowAction.data.meta as any).actionIntent, 'approve');
    }
});

test('business resolver returns expected errors for not found, ambiguous, bad args', () => {
    const { snapshot, finalEntityView } = createFixture();

    const notFound = queryBusinessEntity(snapshot, finalEntityView, 'missing.tag', 'table.rowCount');
    assert.equal(notFound.ok, false);
    if (!notFound.ok) {
        assert.equal(notFound.error.code, 'ERR_NOT_FOUND');
    }

    const tableEntity = finalEntityView.entities.find((entity) => entity.businessTag === 'order.table.main');
    assert.ok(tableEntity);
    const ambiguousView: FinalEntityView = {
        ...finalEntityView,
        entities: [
            ...finalEntityView.entities,
            {
                ...tableEntity!,
                id: `${tableEntity!.id}_dup`,
            },
        ],
    };
    const ambiguous = queryBusinessEntity(snapshot, ambiguousView, 'order.table.main', 'table.rowCount');
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
        assert.equal(ambiguous.error.code, 'ERR_AMBIGUOUS');
    }

    const badQuery = queryBusinessEntity(snapshot, finalEntityView, 'order.form.main', 'table.rowCount');
    assert.equal(badQuery.ok, false);
    if (!badQuery.ok) {
        assert.equal(badQuery.error.code, 'ERR_BAD_ARGS');
    }

    const badTarget = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'form.field',
        fieldKey: 'orderNo',
    });
    assert.equal(badTarget.ok, false);
    if (!badTarget.ok) {
        assert.equal(badTarget.error.code, 'ERR_BAD_ARGS');
    }

    const missingField = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.form.main', {
        kind: 'form.field',
        fieldKey: 'missingField',
    });
    assert.equal(missingField.ok, false);
    if (!missingField.ok) {
        assert.equal(missingField.error.code, 'ERR_NOT_FOUND');
    }

    const missingAction = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.form.main', {
        kind: 'form.action',
        actionIntent: 'missingAction',
    });
    assert.equal(missingAction.ok, false);
    if (!missingAction.ok) {
        assert.equal(missingAction.error.code, 'ERR_NOT_FOUND');
    }

    const missingRow = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'table.row',
        primaryKey: { fieldKey: 'orderNo', value: 'NOT_EXIST' },
    });
    assert.equal(missingRow.ok, false);
    if (!missingRow.ok) {
        assert.equal(missingRow.error.code, 'ERR_NOT_FOUND');
    }

    const missingRowAction = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'table.row_action',
        primaryKey: { fieldKey: 'orderNo', value: 'NOT_EXIST' },
        actionIntent: 'approve',
    });
    assert.equal(missingRowAction.ok, false);
    if (!missingRowAction.ok) {
        assert.equal(missingRowAction.error.code, 'ERR_NOT_FOUND');
    }
});

test('business resolver outputs camelCase envelope without snake_case keys', () => {
    const { snapshot, finalEntityView } = createFixture();
    const queried = queryBusinessEntity(snapshot, finalEntityView, 'order.table.main', 'table.currentRows');
    assert.equal(queried.ok, true);
    if (queried.ok) {
        const serialized = JSON.stringify(queried.data);
        assert.equal(serialized.includes('business_tag'), false);
        assert.equal(serialized.includes('entity_id'), false);
        assert.equal(serialized.includes('row_node_id'), false);
        assert.equal(serialized.includes('cell_node_id'), false);
        assert.equal(serialized.includes('field_key'), false);
        assert.equal(queried.data.kind, 'value');
    }

    const targeted = resolveBusinessEntityTarget(snapshot, finalEntityView, 'order.table.main', {
        kind: 'table.row_action',
        primaryKey: { fieldKey: 'orderNo', value: 'SO-001' },
        actionIntent: 'approve',
    });
    assert.equal(targeted.ok, true);
    if (targeted.ok) {
        const serialized = JSON.stringify(targeted.data);
        assert.equal(serialized.includes('action_intent'), false);
        assert.equal(serialized.includes('node_id'), false);
        assert.equal(targeted.data.kind, 'nodeId');
    }
});
