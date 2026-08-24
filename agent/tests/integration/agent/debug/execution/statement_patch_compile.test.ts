import test from 'node:test';
import assert from 'node:assert/strict';
import {compileStatementPatch} from '../../../../../src/agent/debug/execution/patch_statement';
import type {
    DslEntityRulesProfile,
    DslEntityRulesResolver,
    DslResolveResolver,
} from '../../../../../src/automation/dsl/link';

const profile: DslEntityRulesProfile = {
    profileName: 'order-page',
    entities: [{
        entityKey: 'orderForm',
        businessTag: 'order.form',
        kind: 'form',
        fields: [],
        actions: [{actionIntent: 'submit', targetKind: 'form.action'}],
        columns: [],
        rowActions: [],
        supportedQueries: [],
    }],
};

const entityResolver: DslEntityRulesResolver = {
    resolveProfile: (profileName) => profileName === profile.profileName
        ? {profile, diagnostics: []}
        : {profile: null, diagnostics: []},
};

const resolveResolver: DslResolveResolver = {
    resolveBundle: (bundleName) => bundleName === 'main'
        ? {resolves: {button: {hint: {raw: {selector: '#button'}}}}, diagnostics: []}
        : {resolves: null, diagnostics: []},
};

test('statement patch requires exactly one executable statement and cannot add imports', () => {
    const multiple = compileStatementPatch('wait 0', 'wait 0\nwait 0');
    assert.equal(multiple.ok, false);
    if (multiple.ok) {throw new Error('expected multi-statement patch rejection');}
    assert.equal(multiple.error.code, 'ERR_DSL_PATCH_INVALID');

    const addedImport = compileStatementPatch('wait 0', 'use entity_rules "order-page" as order\nwait 0', entityResolver);
    assert.equal(addedImport.ok, false);
    if (addedImport.ok) {throw new Error('expected import patch rejection');}
    assert.equal(addedImport.error.code, 'ERR_DSL_PATCH_INVALID');
});

test('statement patch links against existing entity-rule imports', () => {
    const result = compileStatementPatch(
        'use entity_rules "order-page" as order\nwait 0',
        'click order.orderForm.submit',
        entityResolver,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.statement, {
        kind: 'linked_entity_act',
        action: 'click',
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            payload: {kind: 'form.action', actionIntent: 'submit'},
            profileName: 'order-page',
        },
        value: undefined,
    });
});

test('resolve-based statement patch is explicitly unsupported until dynamic sidecars exist', () => {
    const result = compileStatementPatch(
        'use resolves "main" as recorded\nwait 0',
        'click recorded.button',
        undefined,
        resolveResolver,
    );
    assert.equal(result.ok, false);
    if (result.ok) {throw new Error('expected resolve patch rejection');}
    assert.equal(result.error.code, 'ERR_DSL_PATCH_UNSUPPORTED');
    assert.match(result.error.message, /dynamic resolve sidecar/);
});
