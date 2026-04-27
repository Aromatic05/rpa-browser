import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../../src/runner/steps/executors/snapshot/pipeline/build_snapshot';
import { buildExternalIndexes } from '../../../src/runner/steps/executors/snapshot/indexes/external_indexes';
import { buildFinalEntityViewFromSnapshot } from '../../../src/runner/steps/executors/snapshot/core/overlay';
import { resolveTableRowAction, resolveTableRowByPrimaryKey } from '../../../src/runner/steps/executors/snapshot/core/entity_query';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';

const createTableSnapshot = (withRuleOverlay = true) => {
    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerBuyer: UnifiedNode = { id: 'header_buyer', role: 'columnheader', name: '采购人', children: [] };
    const headerOperation: UnifiedNode = { id: 'header_operation', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerBuyer, headerOperation] };

    const approveBtn1: UnifiedNode = { id: 'approve_btn_1', role: 'button', name: '审核', children: [] };
    const viewBtn1: UnifiedNode = { id: 'view_btn_1', role: 'button', name: '查看', children: [] };
    const cellOrderNo1: UnifiedNode = { id: 'cell_order_no_1', role: 'cell', name: 'SO-001', children: [] };
    const cellBuyer1: UnifiedNode = { id: 'cell_buyer_1', role: 'cell', name: 'Alice', children: [] };
    const cellOperation1: UnifiedNode = { id: 'cell_operation_1', role: 'cell', children: [viewBtn1, approveBtn1] };
    const row1: UnifiedNode = { id: 'row_1', role: 'row', children: [cellOrderNo1, cellBuyer1, cellOperation1] };

    const approveBtn2: UnifiedNode = { id: 'approve_btn_2', role: 'button', name: '审核', children: [] };
    const viewBtn2: UnifiedNode = { id: 'view_btn_2', role: 'button', name: '查看', children: [] };
    const cellOrderNo2: UnifiedNode = { id: 'cell_order_no_2', role: 'cell', name: 'SO-002', children: [] };
    const cellBuyer2: UnifiedNode = { id: 'cell_buyer_2', role: 'cell', name: 'Bob', children: [] };
    const cellOperation2: UnifiedNode = { id: 'cell_operation_2', role: 'cell', children: [viewBtn2, approveBtn2] };
    const row2: UnifiedNode = { id: 'row_2', role: 'row', children: [cellOrderNo2, cellBuyer2, cellOperation2] };

    const table: UnifiedNode = { id: 'table_1', role: 'table', name: '订单列表', children: [headerRow, row1, row2] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: {
                id: 'ent_table',
                type: 'region',
                kind: 'table',
                nodeId: 'table_1',
                name: '订单列表',
            },
        },
        byNodeId: {
            table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
        },
    };

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: withRuleOverlay
            ? {
                byRuleId: {},
                byEntityId: {
                    ent_table: {
                        businessTag: 'order.table.main',
                        businessName: '订单列表',
                        primaryKey: {
                            fieldKey: 'buyer',
                            columns: ['采购人'],
                            source: 'annotation',
                        },
                        columns: [
                            { fieldKey: 'orderNo', name: '订单编号', kind: 'text', source: 'annotation' },
                            { fieldKey: 'buyer', name: '采购人', kind: 'text', source: 'annotation' },
                            {
                                fieldKey: 'operation',
                                name: '操作',
                                kind: 'action_column',
                                source: 'annotation',
                                actions: [
                                    { actionIntent: 'view', text: '查看' },
                                    { actionIntent: 'approve', text: '审核' },
                                ],
                            },
                        ],
                    },
                },
                nodeHintsByNodeId: {},
            }
            : {
                byRuleId: {},
                byEntityId: {},
                nodeHintsByNodeId: {},
            },
    });

    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });
    const entity = finalEntityView.entities[0];

    return { snapshot, entity };
};

test('table primaryKey annotation resolves row by business fieldKey', () => {
    const { snapshot, entity } = createTableSnapshot(true);
    const resolved = resolveTableRowByPrimaryKey(snapshot, entity, {
        fieldKey: 'buyer',
        value: 'Bob',
    });

    assert.equal(resolved?.rowNodeId, 'row_2');
    assert.equal(resolved?.cellNodeId, 'cell_buyer_2');
});

test('table action_column resolves row action by primaryKey + actionIntent', () => {
    const { snapshot, entity } = createTableSnapshot(true);
    const resolved = resolveTableRowAction(snapshot, entity, {
        primaryKey: { fieldKey: 'buyer', value: 'Alice' },
        actionIntent: 'approve',
    });

    assert.equal(resolved?.rowNodeId, 'row_1');
    assert.equal(resolved?.cellNodeId, 'cell_operation_1');
    assert.equal(resolved?.nodeId, 'approve_btn_1');
});

test('annotation primaryKey has higher priority than table meta recommendation', () => {
    const { entity } = createTableSnapshot(true);
    assert.equal(entity.primaryKey?.fieldKey, 'buyer');
    assert.equal(entity.primaryKey?.source, 'annotation');
});

test('without annotation primaryKey, table meta still provides candidates and recommended key', () => {
    const { entity } = createTableSnapshot(false);
    assert.equal(entity.primaryKey?.source, 'table_meta');
    assert.equal((entity.tableMeta?.primaryKeyCandidates.length || 0) > 0, true);
});

test('resolveTableRowAction matches action text from child text/content', () => {
    const childTextNode: UnifiedNode = { id: 'approve_text_1', role: 'text', name: '审核', children: [] };
    const approveBtn1: UnifiedNode = { id: 'approve_btn_1', role: 'button', children: [childTextNode] };
    const cellOrderNo1: UnifiedNode = { id: 'cell_order_no_1', role: 'cell', name: 'SO-001', children: [] };
    const cellBuyer1: UnifiedNode = { id: 'cell_buyer_1', role: 'cell', name: 'Alice', children: [] };
    const cellOperation1: UnifiedNode = { id: 'cell_operation_1', role: 'cell', children: [approveBtn1] };
    const row1: UnifiedNode = { id: 'row_1', role: 'row', children: [cellOrderNo1, cellBuyer1, cellOperation1] };

    const headerOrderNo: UnifiedNode = { id: 'header_order_no', role: 'columnheader', name: '订单编号', children: [] };
    const headerBuyer: UnifiedNode = { id: 'header_buyer', role: 'columnheader', name: '采购人', children: [] };
    const headerOperation: UnifiedNode = { id: 'header_operation', role: 'columnheader', name: '操作', children: [] };
    const headerRow: UnifiedNode = { id: 'header_row', role: 'row', children: [headerOrderNo, headerBuyer, headerOperation] };
    const table: UnifiedNode = { id: 'table_1', role: 'table', children: [headerRow, row1] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: { id: 'ent_table', type: 'region', kind: 'table', nodeId: 'table_1' },
        },
        byNodeId: { table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }] },
    };

    const { nodeIndex, bboxIndex, attrIndex, contentStore } = buildExternalIndexes(root);
    const snapshot = buildSnapshot({
        root,
        nodeIndex,
        entityIndex,
        locatorIndex: {},
        bboxIndex,
        attrIndex,
        contentStore,
        ruleEntityOverlay: {
            byRuleId: {},
            byEntityId: {
                ent_table: {
                    primaryKey: { fieldKey: 'buyer', columns: ['采购人'], source: 'annotation' },
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
            },
            nodeHintsByNodeId: {},
        },
    });
    const finalEntityView = buildFinalEntityViewFromSnapshot(snapshot, {
        renamedNodes: {},
        addedEntities: [],
        deletedEntities: [],
    });
    const entity = finalEntityView.entities[0];

    const resolved = resolveTableRowAction(snapshot, entity, {
        primaryKey: { fieldKey: 'buyer', value: 'Alice' },
        actionIntent: 'approve',
    });

    assert.equal(resolved?.nodeId, 'approve_btn_1');
    assert.equal(resolved?.rowNodeId, 'row_1');
    assert.equal(resolved?.cellNodeId, 'cell_operation_1');
});
