import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEntityRules } from '../../src/runner/steps/executors/snapshot/entity_rules/loader';
import { defaultEntityRuleConfig } from '../../src/config/entity_rules';

const writeProfile = (
    rootDir: string,
    profile: string,
    pageKind: 'form' | 'table',
    urlPattern: string,
) => {
    const profileDir = path.join(rootDir, 'profiles', profile);
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
        path.join(profileDir, 'match.yaml'),
        `version: 1\npage:\n  kind: ${pageKind}\n  urlPattern: ${urlPattern}\nentities:\n  - ruleId: main\n    source: region\n    expect: unique\n    match:\n      kind: ${pageKind}\n`,
        'utf-8',
    );
    fs.writeFileSync(
        path.join(profileDir, 'annotation.yaml'),
        'version: 1\npage:\n  kind: table\nannotations:\n  - ruleId: main\n    businessTag: sample.main\n'.replace('table', pageKind),
        'utf-8',
    );
};

test('entity rule loader selects explicit profile under profiles dir', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-rules-loader-'));
    writeProfile(tmp, 'oa-ant-orders', 'table', 'ant-order-list');

    const loaded = loadEntityRules({
        config: {
            ...defaultEntityRuleConfig,
            enabled: true,
            rootDir: tmp,
            selection: 'explicit',
            profiles: ['oa-ant-orders'],
            strict: true,
        },
        pageKind: 'table',
        pageUrl: 'http://localhost/pages/entity-rules/ant-order-list.html',
    });

    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.selectedProfile, 'oa-ant-orders');
    assert.equal(loaded.bundle?.id, 'oa-ant-orders');
});

test('entity rule loader strict=false returns warning when profile missing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-rules-loader-'));
    fs.mkdirSync(path.join(tmp, 'profiles'), { recursive: true });

    const loaded = loadEntityRules({
        config: {
            ...defaultEntityRuleConfig,
            enabled: true,
            rootDir: tmp,
            selection: 'explicit',
            profiles: ['missing-profile'],
            strict: false,
        },
        pageKind: 'table',
        pageUrl: 'http://localhost/pages/entity-rules/ant-order-list.html',
    });

    assert.equal(loaded.errors.length, 0);
    assert.equal(loaded.warnings.length > 0, true);
    assert.equal(loaded.bundle, undefined);
});
