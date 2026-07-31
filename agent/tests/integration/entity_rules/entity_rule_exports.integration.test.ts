import test from 'node:test';
import assert from 'node:assert/strict';
import {buildEntityRuleExportIndex, validateWorkflowEntityRules} from '../../../src/workflow';
import {createWorkspaceEntityRulesProvider} from '../../../src/snapshot/rules/runtime';
import type {WorkflowEntityRules} from '../../../src/workflow';

const profile = (overrides: Partial<WorkflowEntityRules> = {}): WorkflowEntityRules => ({
    kind: 'entity_rules',
    name: 'orders',
    page: {kind: 'table'},
    match: {version: 2, rules: [
        {ruleId: 'orders-root', source: 'region', expect: 'unique', match: {kind: 'table'}},
        {ruleId: 'order-no', source: 'node', expect: 'unique', within: 'orders-root', match: {nameEquals: 'orderNo'}},
        {ruleId: 'export', source: 'node', expect: 'unique', within: 'orders-root', match: {nameEquals: 'export'}},
    ]},
    annotation: {version: 2, bindings: [
        {
            ruleId: 'orders-root', entityKey: 'orders', businessTag: 'orders.table', entityKind: 'table',
            displayName: 'Orders', primaryKey: {fieldKey: 'orderNo'},
            columns: [{fieldKey: 'orderNo', name: 'Order number', actions: [{actionIntent: 'approve'}]}],
        },
        {ruleId: 'order-no', fieldKey: 'orderNo', fieldName: 'Order number'},
        {ruleId: 'export', actionIntent: 'export', actionText: 'Export'},
    ]},
    ...overrides,
});

test('exports stable symbols without deriving from labels', () => {
    const first = buildEntityRuleExportIndex(profile());
    const renamed = profile();
    renamed.annotation.bindings[0].displayName = '订单列表';
    renamed.annotation.bindings[1].fieldName = '订单编号';
    renamed.annotation.bindings[2].actionText = '导出';
    const second = buildEntityRuleExportIndex(renamed);

    assert.deepEqual(
        first.index && {profileName: first.index.profileName, entities: first.index.entities},
        second.index && {profileName: second.index.profileName, entities: second.index.entities},
    );
    assert.deepEqual(first.index?.entities[0]?.members, [
        {kind: 'field', symbol: 'orderNo'},
        {kind: 'action', symbol: 'export'},
        {kind: 'rowAction', symbol: 'approve', rowPrimaryKey: 'orderNo'},
        {kind: 'query', symbol: 'currentRows'},
        {kind: 'query', symbol: 'rowCount'},
    ]);
    assert.deepEqual(first.index?.entities[0]?.fields, [
        {fieldKey: 'orderNo', targetKind: 'table.filter'},
    ]);
    assert.deepEqual(first.index?.entities[0]?.columns, [{fieldKey: 'orderNo'}]);
    assert.deepEqual(first.index?.entities[0]?.supportedQueries, ['table.currentRows', 'table.rowCount']);
});

test('diagnoses duplicate entity keys and ambiguous member symbols', () => {
    const duplicateRoot = structuredClone(profile().annotation.bindings[0]);
    duplicateRoot.ruleId = 'other-root';
    duplicateRoot.businessTag = 'orders.other';
    const duplicateRule = {ruleId: 'other-root', source: 'region' as const, expect: 'unique' as const, match: {kind: 'table'}};
    const base = profile();
    const ambiguous = profile({
        match: {version: 2, rules: [...base.match.rules, duplicateRule, {ruleId: 'same-symbol', source: 'node', expect: 'unique', within: 'orders-root', match: {nameEquals: 'same'}}]},
        annotation: {version: 2, bindings: [...base.annotation.bindings, duplicateRoot, {ruleId: 'same-symbol', actionIntent: 'orderNo'}]},
    });
    const result = buildEntityRuleExportIndex(ambiguous);

    assert.equal(result.index, null);
    assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), [
        'entity_rule_exports.ambiguous_member_symbol',
        'entity_rule_exports.duplicate_entity_key',
    ]);
});

test('leaves V2 profiles without entityKey runtime-readable but non-exportable', () => {
    const legacy = profile();
    delete legacy.annotation.bindings[0].entityKey;
    assert.equal(validateWorkflowEntityRules(legacy).name, 'orders');
    const result = buildEntityRuleExportIndex(legacy);

    assert.equal(result.index, null);
    assert.equal(result.diagnostics[0]?.code, 'entity_rule_exports.missing_entity_key');
});

test('uses the profile page kind when the root binding and root rule omit it', () => {
    const fallback = profile();
    delete fallback.annotation.bindings[0].entityKind;
    fallback.match = {
        ...fallback.match,
        rules: fallback.match.rules.map((rule, index) => index === 0
            ? {...rule, match: {}}
            : rule),
    };

    const result = buildEntityRuleExportIndex(fallback);

    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.index?.entities[0]?.kind, 'table');
});

test('diagnoses malformed table primary keys', () => {
    const invalid = profile();
    invalid.annotation.bindings[0].primaryKey = {fieldKey: 'missing'};

    assert.equal(
        buildEntityRuleExportIndex(invalid).diagnostics.some((diagnostic) =>
            diagnostic.code === 'entity_rule_exports.malformed_primary_key'),
        true,
    );
});

test('workflow provider resolves a named profile through the export contract', () => {
    const rules = profile();
    const provider = createWorkspaceEntityRulesProvider({
        name: 'workflow',
        save: (artifact) => artifact,
        get: (name) => name === rules.name ? rules : null,
        list: () => [{kind: 'entity_rules', name: rules.name, title: rules.name, createdAt: 0, updatedAt: 0, summary: ''}],
        delete: () => false,
    });

    assert.equal(provider.resolveExports('orders').index?.resolve('orders', 'export')?.kind, 'action');
    assert.equal(provider.resolveExports('missing').diagnostics[0]?.code, 'entity_rule_exports.profile_not_found');
});
