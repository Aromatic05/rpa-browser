import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEntityRules } from '../../../src/runner/steps/executors/snapshot/entity_rules/validate';

const makeValid = () => ({
    match: {
        version: 1,
        page: { kind: 'table' },
        entities: [
            { ruleId: 'table', source: 'region', expect: 'unique', match: { kind: 'table' } },
            { ruleId: 'row_action', source: 'node', expect: 'one_or_more', within: 'table', match: { textContains: 'Delete' } },
        ],
    },
    annotation: {
        version: 1,
        page: { kind: 'table' },
        annotations: [
            {
                ruleId: 'table',
                businessTag: 'order.list.main',
                columns: [{ fieldKey: 'orderNo', name: 'Order No' }],
                primaryKey: { fieldKey: 'orderNo', columns: ['orderNo'] },
            },
            {
                ruleId: 'row_action',
                actionIntent: 'delete',
            },
        ],
    },
});

test('validate rules catches missing annotation.ruleId mapping', () => {
    const payload = makeValid();
    payload.annotation.annotations[0].ruleId = 'missing';

    const result = validateEntityRules('order-list', payload.match, payload.annotation);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('annotation.ruleId not found')));
});

test('validate rules catches missing within target', () => {
    const payload = makeValid();
    payload.match.entities[1].within = 'not-exists';

    const result = validateEntityRules('order-list', payload.match, payload.annotation);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('within target not found')));
});

test('validate rules catches within cycles', () => {
    const payload = makeValid();
    payload.match.entities = [
        { ruleId: 'a', source: 'region', expect: 'unique', within: 'b', match: { kind: 'table' } },
        { ruleId: 'b', source: 'group', expect: 'one_or_more', within: 'a', match: { kind: 'table' } },
    ];
    payload.annotation.annotations = [{ ruleId: 'a', businessTag: 'x' }, { ruleId: 'b', businessTag: 'y' }];

    const result = validateEntityRules('order-list', payload.match, payload.annotation);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('within cycle detected')));
});

test('validate rules catches page.kind mismatch', () => {
    const payload = makeValid();
    payload.annotation.page.kind = 'form';

    const result = validateEntityRules('order-list', payload.match, payload.annotation);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.errors.some((error) => error.includes('page.kind mismatch')));
});
