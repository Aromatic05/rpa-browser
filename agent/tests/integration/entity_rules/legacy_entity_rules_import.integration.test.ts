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

test('legacy importer rejects a root rule that contradicts or loses page kind', () => {
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

    assert.throws(() => importWorkflowEntityRules({
        kind: 'entity_rules',
        name: 'legacy-root-missing',
        match: {
            ...legacyMatch,
            entities: legacyMatch.entities.map((rule, index) => index === 0
                ? {...rule, match: {idEquals: 'Orders'}}
                : rule),
        },
        annotation: legacyAnnotation,
    }), /cannot preserve table page kind/);
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
