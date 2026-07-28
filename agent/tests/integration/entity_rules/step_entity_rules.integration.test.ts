import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveStepEntityRulesExecution,
    type WorkspaceEntityRulesProvider,
} from '../../../src/snapshot/rules/runtime';
import type { EntityRuleConfig } from '../../../src/config';
import { createEntityRulesCodec } from '../../../src/workflow/entity_rules';

const unavailableProvider: WorkspaceEntityRulesProvider = {
    availability: 'not-implemented',
    workflowName: 'step-rules',
    reason: 'Snapshot V2 entity_rules provider is not implemented',
};

const disabledConfig: EntityRuleConfig = {
    enabled: false,
    rootDir: '.rpa/entity_rules',
    selection: 'disabled',
    profiles: [],
    strict: true,
};

const explicitConfig: EntityRuleConfig = {
    enabled: true,
    rootDir: '.rpa/entity_rules',
    selection: 'explicit',
    profiles: ['workflow-default'],
    strict: true,
};

test('an explicit per-step entityRules selection activates exactly the requested profiles', () => {
    const result = resolveStepEntityRulesExecution({
        selection: 'explicit',
        profiles: ['orders', 'order-form'],
        strict: false,
    }, disabledConfig, unavailableProvider);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.profiles, ['orders', 'order-form']);
    assert.equal(result.strict, false);
});

test('an auto per-step entityRules selection resolves available workflow profiles', () => {
    const result = resolveStepEntityRulesExecution({
        selection: 'auto',
        strict: true,
    }, disabledConfig, unavailableProvider);

    assert.equal(result.status, 'ready');
    assert.ok(result.profiles.length > 0);
});

test('an inherited entityRules selection applies workspace configuration to every step', () => {
    const result = resolveStepEntityRulesExecution({
        selection: 'inherit',
    }, explicitConfig, unavailableProvider);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.profiles, ['workflow-default']);
    assert.equal(result.strict, true);
});

test('workflow entity_rules artifacts can be saved and loaded by the V2 codec', () => {
    const codec = createEntityRulesCodec('step-rules');
    const saved = codec.save({
        kind: 'entity_rules',
        name: 'orders',
        match: { version: 2, rules: [] },
        annotation: { version: 2, bindings: [] },
    });

    assert.equal(saved.name, 'orders');
    assert.equal(codec.load('orders')?.name, 'orders');
});
