import test from 'node:test';
import assert from 'node:assert/strict';
import {
    importWorkflowEntityRules,
    validateWorkflowEntityRules,
} from '../../../src/workflow';
import {compileEntityRuleQueryPlan} from '../../../src/snapshot';

const legacyMatch = {
    version: 1,
    page: {kind: 'table', urlPattern: '/orders$'},
    entities: [
        {
            ruleId: 'orders',
            source: 'region',
            expect: 'unique',
            match: {kind: 'table'},
        },
        {
            ruleId: 'next-page',
            source: 'node',
            expect: 'unique',
            match: {relation: 'pagination', classContains: 'ant-pagination-next'},
        },
    ],
};

const legacyAnnotation = {
    version: 1,
    page: {kind: 'table'},
    annotations: [
        {ruleId: 'orders', businessTag: 'order.list', primaryKey: {fieldKey: 'orderNo'}},
        {ruleId: 'next-page', actionIntent: 'nextPage'},
    ],
};

test('legacy entity_rules import into the V2 artifact and compile through the single QueryPlan runtime', () => {
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-orders',
        match: legacyMatch,
        annotation: legacyAnnotation,
    });

    assert.equal(imported.match.version, 2);
    assert.equal(imported.annotation.version, 2);
    assert.deepEqual(
        imported.match.rules.map(({within, ...rule}) => within === undefined ? rule : {...rule, within}),
        legacyMatch.entities,
    );
    assert.deepEqual(imported.annotation.bindings, legacyAnnotation.annotations);
    assert.deepEqual(imported.page, {kind: 'table', urlPattern: '/orders$'});
    assert.equal(Object.prototype.hasOwnProperty.call(imported.match, 'page'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(imported.annotation, 'page'), false);

    const compiled = compileEntityRuleQueryPlan({
        profileName: imported.name,
        rules: imported.match.rules,
    });
    assert.equal(compiled.ok, true);
});

test('legacy importer rejects page-kind disagreement instead of guessing a domain', () => {
    assert.throws(() => importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-mismatch',
        match: legacyMatch,
        annotation: {...legacyAnnotation, page: {kind: 'form'}},
    }), /page kind mismatch/);
});

test('legacy importer accepts page-scoped rules without an explicit kind and rejects contradictions', () => {
    assert.throws(() => importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-root-mismatch',
        match: {
            ...legacyMatch,
            entities: legacyMatch.entities.map((rule, index) => index === 0
                ? {...rule, match: {kind: 'form'}}
                : rule),
        },
        annotation: legacyAnnotation,
    }), /cannot preserve table page kind/);

    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-root-missing',
        match: {
            ...legacyMatch,
            entities: legacyMatch.entities.map((rule, index) => index === 0
                ? {...rule, match: {idEquals: 'Orders'}}
                : rule),
        },
        annotation: legacyAnnotation,
    });
    assert.deepEqual(imported.page, {kind: 'table', urlPattern: '/orders$'});
    const compiled = compileEntityRuleQueryPlan({
        profileName: imported.name,
        domain: imported.page?.kind === 'table' ? 'table' : undefined,
        rules: imported.match.rules,
    });
    assert.equal(compiled.ok, true);
});

test('legacy generic page kind is preserved even when node rules omit match.kind', () => {
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-dialog-without-kind',
        match: {
            version: 1,
            page: {kind: 'dialog', urlPattern: '/confirm'},
            entities: [{
                ruleId: 'close-dialog',
                source: 'node',
                expect: 'unique',
                match: {classContains: 'close-button', textContains: '关闭'},
            }],
        },
        annotation: {
            version: 1,
            page: {kind: 'dialog'},
            annotations: [{ruleId: 'close-dialog', businessTag: 'dialog.close'}],
        },
    });
    assert.deepEqual(imported.page, {kind: 'dialog', urlPattern: '/confirm'});
    const compiled = compileEntityRuleQueryPlan({
        profileName: imported.name,
        domain: 'node',
        rules: imported.match.rules,
    });
    assert.equal(compiled.ok, true);
});

test('V2 publication validation preserves structural contains dependencies', () => {
    const validated = validateWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'orders-module',
        page: {kind: 'table'},
        match: {
            version: 2,
            rules: [
                {ruleId: 'table', source: 'region', expect: 'unique', match: {kind: 'table', idEquals: 'Orders'}},
                {ruleId: 'scope', source: 'node', expect: 'unique', contains: 'table', match: {classContains: 'ant-card-body'}},
                {ruleId: 'filter', source: 'node', expect: 'unique', within: 'scope', match: {placeholderEquals: '订单编号'}},
            ],
        },
        annotation: {version: 2, bindings: [{ruleId: 'table', businessTag: 'orders.table'}]},
    });

    assert.equal(validated.match.rules.find((rule) => rule.ruleId === 'scope')?.contains, 'table');
    assert.throws(() => validateWorkflowEntityRules({
        ...validated,
        match: {
            version: 2,
            rules: validated.match.rules.map((rule) => rule.ruleId === 'scope'
                ? {...rule, contains: 'missing'}
                : rule),
        },
    }), /contains target not found/);
    assert.throws(() => validateWorkflowEntityRules({
        ...validated,
        match: {
            version: 2,
            rules: [
                {ruleId: 'scope', source: 'node', expect: 'unique', contains: 'filter', match: {classContains: 'ant-card-body'}},
                {ruleId: 'filter', source: 'node', expect: 'unique', within: 'scope', match: {placeholderEquals: '订单编号'}},
                {ruleId: 'table', source: 'region', expect: 'unique', match: {kind: 'table'}},
            ],
        },
    }), /dependency cycle/);
});

test('V2 publication validation remains strict and does not accept legacy artifacts directly', () => {
    assert.throws(() => validateWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-orders',
        match: legacyMatch,
        annotation: legacyAnnotation,
    }), /version=2/);
});


test('legacy dialog profiles preserve page applicability and compile to the generic node domain', () => {
    const imported = importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-dialog',
        match: {
            version: 1,
            page: {kind: 'dialog', urlPattern: '/orders'},
            entities: [{
                ruleId: 'confirm-dialog',
                source: 'node',
                expect: 'unique',
                match: {kind: 'dialog', roleEquals: 'dialog', nameContains: 'Confirm'},
            }],
        },
        annotation: {
            version: 1,
            page: {kind: 'dialog'},
            annotations: [{ruleId: 'confirm-dialog', businessTag: 'order.confirm'}],
        },
    });
    assert.deepEqual(imported.page, {kind: 'dialog', urlPattern: '/orders'});
    const compiled = compileEntityRuleQueryPlan({
        profileName: imported.name,
        domain: 'node',
        rules: imported.match.rules,
    });
    assert.equal(compiled.ok, true);
    if (compiled.ok) {assert.equal(compiled.plan.domain, 'node');}
});
