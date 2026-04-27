import test from 'node:test';
import assert from 'node:assert/strict';
import { entityAnnotationSetSchema, entityMatchRuleSetSchema } from '../../../src/runner/steps/executors/snapshot/entity_rules/schema';

test('match rule schema accepts valid payload', () => {
    const parsed = entityMatchRuleSetSchema.safeParse({
        version: 1,
        page: { kind: 'table', urlPattern: '/orders' },
        entities: [
            {
                ruleId: 'main_table',
                source: 'region',
                expect: 'unique',
                match: {
                    kind: 'table',
                    nameContains: 'Order',
                    relation: 'pagination',
                },
            },
        ],
    });

    assert.equal(parsed.success, true);
});

test('match rule schema rejects unknown and empty match', () => {
    const parsed = entityMatchRuleSetSchema.safeParse({
        version: 1,
        page: { kind: 'table' },
        entities: [
            {
                ruleId: 'bad',
                source: 'region',
                expect: 'unique',
                match: {},
                businessTag: 'not-allowed',
            },
        ],
    });

    assert.equal(parsed.success, false);
});

test('annotation rule schema accepts valid payload', () => {
    const parsed = entityAnnotationSetSchema.safeParse({
        version: 1,
        page: { kind: 'table' },
        annotations: [
            {
                ruleId: 'main_table',
                businessTag: 'order.list.main',
                businessName: 'Order List',
                columns: [
                    { fieldKey: 'orderNo', name: 'Order No', kind: 'text' },
                    {
                        fieldKey: 'operation',
                        name: 'Operation',
                        kind: 'action_column',
                        actions: [{ actionIntent: 'approve', text: 'Approve' }],
                    },
                ],
                primaryKey: { fieldKey: 'orderNo', columns: ['orderNo'] },
                fields: [
                    {
                        fieldKey: 'dept',
                        kind: 'select',
                        controlRuleId: 'dept_select',
                        optionSource: { kind: 'popup', optionRuleId: 'dept_options' },
                    },
                ],
                actions: [{ actionIntent: 'submit', nodeRuleId: 'submit_btn' }],
            },
        ],
    });

    assert.equal(parsed.success, true);
});

test('annotation rule schema rejects structural fields and unknown keys', () => {
    const parsed = entityAnnotationSetSchema.safeParse({
        version: 1,
        page: { kind: 'table' },
        annotations: [
            {
                ruleId: 'main_table',
                source: 'region',
                match: { kind: 'table' },
            },
        ],
    });

    assert.equal(parsed.success, false);
});
