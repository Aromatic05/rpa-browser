import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultEntityRuleConfig, defaultEntityRuleRootDir, selectEntityRuleProfiles } from '../../src/config/entity_rules';
import { loadRunnerConfig } from '../../src/config/loader';

test('entity rule config default is conservative', () => {
    const config = loadRunnerConfig({ configPath: '__non_exist__.json' });
    assert.equal(config.entityRules.enabled, false);
    assert.equal(config.entityRules.selection, 'explicit');
    assert.deepEqual(config.entityRules.profiles, []);
    assert.equal(config.entityRules.strict, true);
    assert.equal(config.entityRules.rootDir, defaultEntityRuleRootDir());
    assert.equal(defaultEntityRuleConfig.rootDir, defaultEntityRuleRootDir());
});

test('entity rule selection: explicit', () => {
    const selected = selectEntityRuleProfiles(
        {
            ...defaultEntityRuleConfig,
            enabled: true,
            selection: 'explicit',
            profiles: ['oa-ant-orders'],
            strict: true,
        },
        [
            { name: 'oa-ant-orders', pageKind: 'table', urlPattern: 'order-list' },
            { name: 'oa-element-users', pageKind: 'table', urlPattern: 'user-list' },
        ],
        { kind: 'table', url: 'http://127.0.0.1:5173/entity-rules/fixtures/order-list' },
    );

    assert.deepEqual(selected.selected, ['oa-ant-orders']);
    assert.deepEqual(selected.errors, []);
});

test('entity rule selection: auto', () => {
    const selected = selectEntityRuleProfiles(
        {
            ...defaultEntityRuleConfig,
            enabled: true,
            selection: 'auto',
            strict: true,
        },
        [
            { name: 'oa-ant-orders', pageKind: 'table', urlPattern: 'order-list' },
            { name: 'oa-element-users', pageKind: 'table', urlPattern: 'user-list' },
        ],
        { kind: 'table', url: 'http://127.0.0.1:5174/entity-rules/fixtures/user-list' },
    );

    assert.deepEqual(selected.selected, ['oa-element-users']);
    assert.deepEqual(selected.errors, []);
});

test('entity rule selection: multi-profile conflict', () => {
    const selected = selectEntityRuleProfiles(
        {
            ...defaultEntityRuleConfig,
            enabled: true,
            selection: 'auto',
            strict: true,
        },
        [
            { name: 'oa-ant-orders', pageKind: 'table', urlPattern: 'order-list' },
            { name: 'oa-ant-orders-v2', pageKind: 'table', urlPattern: 'order-list' },
        ],
        { kind: 'table', url: 'http://127.0.0.1:5173/entity-rules/fixtures/order-list' },
    );

    assert.equal(selected.selected.length, 2);
    assert.equal(selected.errors.some((item) => item.includes('conflict')), true);
});

test('entity rule selection: strict/non-strict missing behavior', () => {
    const strictResult = selectEntityRuleProfiles(
        {
            ...defaultEntityRuleConfig,
            enabled: true,
            selection: 'explicit',
            profiles: ['missing-profile'],
            strict: true,
        },
        [{ name: 'oa-ant-orders', pageKind: 'table' }],
        { kind: 'table', url: 'http://127.0.0.1:5173/entity-rules/fixtures/order-list' },
    );
    assert.equal(strictResult.errors.length > 0, true);

    const nonStrictResult = selectEntityRuleProfiles(
        {
            ...defaultEntityRuleConfig,
            enabled: true,
            selection: 'explicit',
            profiles: ['missing-profile'],
            strict: false,
        },
        [{ name: 'oa-ant-orders', pageKind: 'table' }],
        { kind: 'table', url: 'http://127.0.0.1:5173/entity-rules/fixtures/order-list' },
    );
    assert.equal(nonStrictResult.errors.length, 0);
    assert.equal(nonStrictResult.warnings.length > 0, true);
});
