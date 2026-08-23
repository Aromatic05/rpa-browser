import test from 'node:test';
import assert from 'node:assert/strict';
import {
    projectEntityRuleEntities,
    projectEntityRuleProfileSummary,
    projectEntityRuleProfileView,
} from '../../../src/snapshot/rules/runtime/presentation';
import type {WorkflowEntityRules} from '../../../src/workflow';

const profile: WorkflowEntityRules = {
    kind: 'entity_rules',
    name: 'orders-page-rule',
    page: {kind: 'table', urlPattern: '/orders'},
    match: {
        version: 2,
        rules: [
            {ruleId: 'query-root', source: 'region', expect: 'unique', match: {kind: 'form'}},
            {ruleId: 'table-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
        ],
    },
    annotation: {
        version: 2,
        bindings: [
            {
                ruleId: 'query-root',
                businessTag: 'orders.query',
                displayName: '订单查询',
                legacyCanvas: {
                    entities: [
                        {
                            kind: 'form',
                            name: '订单查询',
                            businessTag: 'orders.query',
                            annotations: [
                                {type: 'field', businessKey: 'orderNo', name: '订单编号', disposition: 'active'},
                                {type: 'action', businessKey: 'query', name: '查询', disposition: 'active'},
                            ],
                            columns: [],
                        },
                        {
                            kind: 'table',
                            name: '订单列表',
                            businessTag: 'orders.table',
                            annotations: [],
                            columns: [{fieldKey: 'wrong', name: '错误列', actions: [], disposition: 'active'}],
                        },
                    ],
                },
            },
            {
                ruleId: 'table-root',
                businessTag: 'orders.table',
                displayName: '订单列表',
                legacyCanvas: {
                    entities: [
                        {
                            kind: 'form',
                            name: '订单查询',
                            businessTag: 'orders.query',
                            annotations: [],
                            columns: [],
                        },
                        {
                            kind: 'table',
                            name: '订单列表',
                            businessTag: 'orders.table',
                            annotations: [{type: 'action', businessKey: 'export', name: '导出', disposition: 'active'}],
                            primaryKey: {fieldKey: 'orderNo'},
                            columns: [
                                {fieldKey: 'orderNo', name: '订单编号', actions: [], disposition: 'active'},
                                {
                                    fieldKey: 'actions',
                                    name: '操作',
                                    actions: [{actionIntent: 'approve', disposition: 'active'}],
                                    disposition: 'active',
                                },
                            ],
                            pagination: {actionIntent: 'paginate'},
                        },
                    ],
                },
            },
        ],
    },
};

test('rule presentation exposes business content and keeps multi-entity roots exact', () => {
    const entities = projectEntityRuleEntities(profile);
    assert.equal(entities.length, 2);
    assert.deepEqual(entities[0], {
        profileName: 'orders-page-rule',
        businessTag: 'orders.query',
        entityKind: 'form',
        label: '订单查询',
        fields: [{fieldKey: 'orderNo', label: '订单编号', targetKind: 'form.field'}],
        actions: [{actionIntent: 'query', label: '查询', targetKind: 'form.action'}],
        rowActions: [],
        columns: [],
        hasPagination: false,
    });
    assert.equal(entities[1].businessTag, 'orders.table');
    assert.deepEqual(entities[1].columns, [
        {fieldKey: 'orderNo', label: '订单编号', primaryKey: true, actionCount: 0},
        {fieldKey: 'actions', label: '操作', primaryKey: false, actionCount: 1},
    ]);
    assert.equal(entities[1].columns.some((column) => column.fieldKey === 'wrong'), false);
    assert.equal(entities[1].hasPagination, true);
});

test('rule presentation returns a list summary and detailed view from the same projection', () => {
    assert.deepEqual(projectEntityRuleProfileSummary(profile), {
        profileName: 'orders-page-rule',
        label: '订单查询',
        pageKind: 'table',
        urlPattern: '/orders',
        entityCount: 2,
    });
    const detail = projectEntityRuleProfileView(profile);
    assert.equal(detail.entities.length, 2);
    assert.deepEqual(
        detail.entities.map((entity) => entity.label),
        ['订单查询', '订单列表'],
    );
});

test('pure V2 multi-entity presentation keeps fallback fields and actions scoped to each root', () => {
    const pureV2Profile: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'pure-v2-orders',
        page: {kind: 'table', urlPattern: '/orders'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'query-root', source: 'region', expect: 'unique', match: {kind: 'form'}},
                {ruleId: 'query-order-no', source: 'node', expect: 'unique', within: 'query-root', match: {placeholderEquals: '订单编号'}},
                {ruleId: 'query-submit', source: 'node', expect: 'unique', within: 'query-root', match: {textContains: '查询'}},
                {ruleId: 'table-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
                {ruleId: 'table-scope', source: 'node', expect: 'unique', contains: 'table-root', match: {classContains: 'orders-module'}},
                {ruleId: 'table-buyer', source: 'node', expect: 'unique', within: 'table-scope', match: {placeholderEquals: '采购人'}},
                {ruleId: 'table-export', source: 'node', expect: 'unique', within: 'table-root', match: {textContains: '导出'}},
            ],
        },
        annotation: {
            version: 2,
            bindings: [
                {
                    ruleId: 'query-root',
                    businessTag: 'orders.query',
                    displayName: '订单查询',
                    entityKind: 'form',
                },
                {ruleId: 'query-order-no', fieldKey: 'orderNo', fieldName: '订单编号'},
                {ruleId: 'query-submit', actionIntent: 'query', actionText: '查询'},
                {
                    ruleId: 'table-root',
                    businessTag: 'orders.table',
                    displayName: '订单列表',
                    entityKind: 'table',
                    primaryKey: {fieldKey: 'orderNo'},
                    columns: [
                        {fieldKey: 'orderNo', name: '订单编号'},
                        {fieldKey: 'actions', name: '操作', actions: [{actionIntent: 'approve'}]},
                    ],
                    pagination: {nextAction: {actionIntent: 'next'}},
                },
                {ruleId: 'table-buyer', fieldKey: 'buyer', fieldName: '采购人'},
                {ruleId: 'table-export', actionIntent: 'export', actionText: '导出'},
            ],
        },
    };

    assert.deepEqual(projectEntityRuleEntities(pureV2Profile), [
        {
            profileName: 'pure-v2-orders',
            businessTag: 'orders.query',
            entityKind: 'form',
            label: '订单查询',
            fields: [{fieldKey: 'orderNo', label: '订单编号', targetKind: 'form.field'}],
            actions: [{actionIntent: 'query', label: '查询', targetKind: 'form.action'}],
            rowActions: [],
            columns: [],
            hasPagination: false,
        },
        {
            profileName: 'pure-v2-orders',
            businessTag: 'orders.table',
            entityKind: 'table',
            label: '订单列表',
            fields: [{fieldKey: 'buyer', label: '采购人', targetKind: 'table.filter'}],
            actions: [{actionIntent: 'export', label: '导出', targetKind: 'table.module_action'}],
            rowActions: [{actionIntent: 'approve', label: 'approve', targetKind: 'table.row_action'}],
            primaryKey: {fieldKey: 'orderNo', label: '订单编号'},
            columns: [
                {fieldKey: 'orderNo', label: '订单编号', primaryKey: true, actionCount: 0},
                {fieldKey: 'actions', label: '操作', primaryKey: false, actionCount: 1},
            ],
            hasPagination: true,
        },
    ]);
});

test('rule presentation exposes explicit effect reversibility from current V2 bindings', () => {
    const semanticProfile: WorkflowEntityRules = {
        kind: 'entity_rules',
        name: 'semantic-orders',
        page: {kind: 'table'},
        match: {version: 2, rules: [
            {ruleId: 'root', source: 'region', expect: 'unique', match: {kind: 'table'}},
            {ruleId: 'filter', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'buyer'}},
            {ruleId: 'export', source: 'node', expect: 'unique', within: 'root', match: {nameEquals: 'export'}},
        ]},
        annotation: {version: 2, bindings: [
            {
                ruleId: 'root',
                entityKey: 'orders',
                businessTag: 'orders.table',
                entityKind: 'table',
                primaryKey: {fieldKey: 'orderNo'},
                columns: [
                    {fieldKey: 'orderNo', name: 'Order No'},
                    {fieldKey: 'actions', name: 'Actions', actions: [{
                        actionIntent: 'approve',
                        effect: {reversibility: 'compensatable'},
                    }]},
                ],
                legacyCanvas: {
                    entities: [{
                        kind: 'table',
                        name: 'Legacy Orders',
                        businessTag: 'orders.table',
                        annotations: [
                            {type: 'field', businessKey: 'buyer', name: 'Buyer', disposition: 'active'},
                            {type: 'action', businessKey: 'export', name: 'Export', disposition: 'active'},
                        ],
                        primaryKey: {fieldKey: 'orderNo'},
                        columns: [{
                            fieldKey: 'actions',
                            name: 'Actions',
                            disposition: 'active',
                            actions: [{actionIntent: 'approve', disposition: 'active'}],
                        }],
                    }],
                },
            },
            {
                ruleId: 'filter',
                fieldKey: 'buyer',
                fieldName: 'Buyer',
                effect: {reversibility: 'reversible'},
            },
            {
                ruleId: 'export',
                actionIntent: 'export',
                actionText: 'Export',
                effect: {reversibility: 'irreversible'},
            },
        ]},
    };

    const entity = projectEntityRuleEntities(semanticProfile)[0];
    assert.deepEqual(entity.fields, [{
        fieldKey: 'buyer',
        label: 'Buyer',
        targetKind: 'table.filter',
        effect: {reversibility: 'reversible'},
    }]);
    assert.deepEqual(entity.actions, [{
        actionIntent: 'export',
        label: 'Export',
        targetKind: 'table.module_action',
        effect: {reversibility: 'irreversible'},
    }]);
    assert.deepEqual(entity.rowActions, [{
        actionIntent: 'approve',
        label: 'approve',
        targetKind: 'table.row_action',
        effect: {reversibility: 'compensatable'},
    }]);
});
