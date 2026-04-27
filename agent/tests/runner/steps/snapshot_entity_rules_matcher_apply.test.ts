import test from 'node:test';
import assert from 'node:assert/strict';
import { matchEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/matcher';
import { applyEntityRuleBindings } from '../../../src/runner/steps/executors/snapshot/entity_rules/apply';
import type { EntityIndex, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { getNodeSemanticHints, setNodeAttr } from '../../../src/runner/steps/executors/snapshot/core/runtime_store';
import type { NormalizedEntityRuleBundle } from '../../../src/runner/steps/executors/snapshot/entity_rules/types';

const buildFixture = () => {
    const deleteBtn: UnifiedNode = { id: 'node_delete', role: 'button', name: 'Delete', children: [] };
    const editBtn: UnifiedNode = { id: 'node_edit', role: 'button', name: 'Edit', children: [] };
    const row: UnifiedNode = { id: 'row_1', role: 'row', children: [editBtn, deleteBtn] };
    const pagination: UnifiedNode = { id: 'pager_1', role: 'navigation', name: 'Pagination', children: [] };
    const table: UnifiedNode = { id: 'table_1', role: 'table', name: 'Order List', children: [row, pagination] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [table] };

    setNodeAttr(table, 'class', 'order-table');
    setNodeAttr(pagination, 'class', 'pagination');
    setNodeAttr(deleteBtn, 'aria-label', 'Delete Order');

    const entityIndex: EntityIndex = {
        entities: {
            ent_table: {
                id: 'ent_table',
                type: 'region',
                kind: 'table',
                nodeId: 'table_1',
                name: 'Order List',
                keyHint: {
                    slot: 0,
                    source: 'region_header',
                    confidence: 0.9,
                    name: 'Order No',
                    sampleValues: ['A001', 'A002'],
                },
            },
            ent_rows: {
                id: 'ent_rows',
                type: 'group',
                kind: 'table',
                containerId: 'table_1',
                itemIds: ['row_1'],
                keySlot: 0,
            },
        },
        byNodeId: {
            table_1: [
                { type: 'region', entityId: 'ent_table', role: 'container' },
                { type: 'group', entityId: 'ent_rows', role: 'container' },
            ],
            row_1: [{ type: 'group', entityId: 'ent_rows', role: 'item', itemId: 'row_1' }],
            node_delete: [{ type: 'group', entityId: 'ent_rows', role: 'descendant', itemId: 'row_1' }],
            node_edit: [{ type: 'group', entityId: 'ent_rows', role: 'descendant', itemId: 'row_1' }],
            pager_1: [{ type: 'region', entityId: 'ent_table', role: 'descendant' }],
        },
    };

    const bundle: NormalizedEntityRuleBundle = {
        id: 'order-list',
        page: { kind: 'table' },
        matchRules: [
            {
                ruleId: 'main_table',
                source: 'region',
                expect: 'unique',
                order: 0,
                match: {
                    kind: 'table',
                    nameContains: 'Order',
                    relation: 'pagination',
                },
            },
            {
                ruleId: 'main_group',
                source: 'group',
                expect: 'one_or_more',
                order: 1,
                within: 'main_table',
                match: {
                    kind: 'table',
                },
            },
            {
                ruleId: 'delete_action',
                source: 'node',
                expect: 'unique',
                order: 2,
                within: 'main_table',
                match: {
                    ariaContains: 'delete',
                },
            },
        ],
        annotationByRuleId: {
            main_table: {
                ruleId: 'main_table',
                businessTag: 'order.list.main',
                businessName: 'Order List Main',
                columns: [
                    { fieldKey: 'orderNo', name: 'Order No', kind: 'text' },
                    {
                        fieldKey: 'operation',
                        name: 'Operation',
                        kind: 'action_column',
                        actions: [{ actionIntent: 'delete', text: 'Delete' }],
                    },
                ],
                primaryKey: { fieldKey: 'orderNo', columns: ['orderNo'] },
            },
            delete_action: {
                ruleId: 'delete_action',
                fieldKey: 'operation',
                actionIntent: 'delete',
            },
        },
    };

    return { root, entityIndex, bundle };
};

test('matcher supports region/group/within and relation pagination', () => {
    const { root, entityIndex, bundle } = buildFixture();
    const bindings = matchEntityRules(bundle, {
        root,
        entityIndex,
    });

    assert.equal(bindings.main_table?.ok, true);
    assert.equal(bindings.main_group?.ok, true);
    assert.equal(bindings.delete_action?.ok, true);
    assert.deepEqual(bindings.delete_action?.matchedNodeIds, ['node_delete']);
});

test('apply maps business info and node semantic hints to overlay', () => {
    const { root, entityIndex, bundle } = buildFixture();
    const bindings = matchEntityRules(bundle, {
        root,
        entityIndex,
    });
    const overlay = applyEntityRuleBindings(bundle, root, entityIndex, bindings);

    assert.equal(overlay.byEntityId.ent_table?.businessTag, 'order.list.main');
    assert.equal(overlay.byEntityId.ent_table?.primaryKey?.fieldKey, 'orderNo');
    assert.equal(overlay.byEntityId.ent_table?.columns?.[0]?.fieldKey, 'orderNo');
    assert.equal(overlay.byEntityId.ent_table?.columns?.[1]?.kind, 'action_column');
    assert.equal(overlay.byEntityId.ent_table?.columns?.[1]?.actions?.[0]?.actionIntent, 'delete');
    assert.equal(overlay.byEntityId.ent_table?.primaryKey?.source, 'annotation');

    assert.equal(overlay.nodeHintsByNodeId.node_delete?.fieldKey, 'operation');
    assert.equal(overlay.nodeHintsByNodeId.node_delete?.actionIntent, 'delete');

    const deleteNode = root.children[0].children[0].children[1];
    const semantic = getNodeSemanticHints(deleteNode);
    assert.equal(semantic?.fieldKey, 'operation');
    assert.equal(semantic?.actionIntent, 'delete');
});

test('apply binds form fields/actions by referenced ruleId and keeps legacy fieldKey/actionIntent', () => {
    const submitBtn: UnifiedNode = { id: 'submit_btn', role: 'button', name: 'Submit', children: [] };
    const orderNoLabel: UnifiedNode = { id: 'order_no_label', role: 'text', name: 'Order No', children: [] };
    const orderNoInput: UnifiedNode = { id: 'order_no_input', role: 'textbox', name: 'Order No Input', children: [] };
    const form: UnifiedNode = { id: 'order_form', role: 'form', name: 'Order Form', children: [orderNoLabel, orderNoInput, submitBtn] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_form: {
                id: 'ent_form',
                type: 'region',
                kind: 'form',
                nodeId: 'order_form',
                name: 'Order Form',
            },
        },
        byNodeId: {
            order_form: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
            order_no_input: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            order_no_label: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
            submit_btn: [{ type: 'region', entityId: 'ent_form', role: 'descendant' }],
        },
    };

    const bundle: NormalizedEntityRuleBundle = {
        id: 'order-form',
        page: { kind: 'form' },
        matchRules: [
            { ruleId: 'order_form', source: 'region', expect: 'unique', order: 0, match: { kind: 'form' } },
            { ruleId: 'order_no_input_rule', source: 'node', expect: 'unique', order: 1, within: 'order_form', match: { textContains: 'Input' } },
            { ruleId: 'order_no_label_rule', source: 'node', expect: 'unique', order: 2, within: 'order_form', match: { textContains: 'Label' } },
            { ruleId: 'submit_rule', source: 'node', expect: 'unique', order: 3, within: 'order_form', match: { textContains: 'Submit' } },
        ],
        annotationByRuleId: {
            order_form: {
                ruleId: 'order_form',
                fields: [
                    {
                        fieldKey: 'orderNo',
                        name: 'Order No',
                        kind: 'input',
                        controlRuleId: 'order_no_input_rule',
                        labelRuleId: 'order_no_label_rule',
                    },
                ],
                actions: [{ actionIntent: 'submit', text: 'Submit', nodeRuleId: 'submit_rule' }],
            },
            submit_rule: {
                ruleId: 'submit_rule',
                fieldKey: 'legacy_submit',
                actionIntent: 'submit_legacy',
            },
        },
    };

    const bindings = matchEntityRules(bundle, { root, entityIndex });
    const overlay = applyEntityRuleBindings(bundle, root, entityIndex, bindings);

    assert.equal(overlay.byEntityId.ent_form?.formFields?.[0]?.fieldKey, 'orderNo');
    assert.equal(overlay.byEntityId.ent_form?.formFields?.[0]?.controlNodeId, 'order_no_input');
    assert.equal(overlay.byEntityId.ent_form?.formActions?.[0]?.actionIntent, 'submit');
    assert.equal(overlay.byEntityId.ent_form?.formActions?.[0]?.nodeId, 'submit_btn');

    assert.equal(overlay.nodeHintsByNodeId.order_no_input?.fieldKey, 'orderNo');
    assert.equal(overlay.nodeHintsByNodeId.order_no_input?.fieldRole, 'control');
    assert.equal(overlay.nodeHintsByNodeId.submit_btn?.actionIntent, 'submit');

    const submitSemantic = getNodeSemanticHints(submitBtn);
    assert.equal(submitSemantic?.actionIntent, 'submit');
    assert.equal(submitSemantic?.fieldKey, 'legacy_submit');
});

test('form action node hint binds to current form entity instead of unrelated preferred entity', () => {
    const submitBtn: UnifiedNode = { id: 'submit_btn', role: 'button', name: 'Submit', children: [] };
    const form: UnifiedNode = { id: 'order_form', role: 'form', name: 'Order Form', children: [submitBtn] };
    const table: UnifiedNode = { id: 'table_1', role: 'table', name: 'Order Table', children: [] };
    const root: UnifiedNode = { id: 'root', role: 'root', children: [form, table] };

    const entityIndex: EntityIndex = {
        entities: {
            ent_form: { id: 'ent_form', type: 'region', kind: 'form', nodeId: 'order_form' },
            ent_table: { id: 'ent_table', type: 'region', kind: 'table', nodeId: 'table_1' },
        },
        byNodeId: {
            order_form: [{ type: 'region', entityId: 'ent_form', role: 'container' }],
            table_1: [{ type: 'region', entityId: 'ent_table', role: 'container' }],
            submit_btn: [
                { type: 'region', entityId: 'ent_table', role: 'container' },
                { type: 'region', entityId: 'ent_form', role: 'descendant' },
            ],
        },
    };

    const bundle: NormalizedEntityRuleBundle = {
        id: 'order-form',
        page: { kind: 'form' },
        matchRules: [
            { ruleId: 'order_form', source: 'region', expect: 'unique', order: 0, match: { kind: 'form' } },
            { ruleId: 'submit_rule', source: 'node', expect: 'unique', order: 1, within: 'order_form', match: { textContains: 'Submit' } },
        ],
        annotationByRuleId: {
            order_form: {
                ruleId: 'order_form',
                actions: [{ actionIntent: 'submit', nodeRuleId: 'submit_rule' }],
            },
        },
    };

    const bindings = matchEntityRules(bundle, { root, entityIndex });
    const overlay = applyEntityRuleBindings(bundle, root, entityIndex, bindings);
    assert.equal(overlay.nodeHintsByNodeId.submit_btn?.entityNodeId, 'order_form');
    assert.equal(overlay.nodeHintsByNodeId.submit_btn?.entityKind, 'form');
});
