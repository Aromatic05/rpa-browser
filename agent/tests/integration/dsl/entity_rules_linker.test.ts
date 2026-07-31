import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import {
    createDslEntityRulesResolver,
    linkDsl,
    type DslEntityRulesProfile,
    type DslEntityRulesResolver,
    type DslResolveResolver,
} from '../../../src/dsl/link';
import { runDslSource, validateDslSource } from '../../../src/dsl/runtime';
import { createWorkspaceEntityRulesProvider } from '../../../src/snapshot/rules/runtime';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { BrowserQueryResult, StepUnion } from '../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';

const profile: DslEntityRulesProfile = {
    profileName: 'order-page',
    entities: [
        {
            entityKey: 'orderForm',
            businessTag: 'order.form',
            kind: 'form',
            fields: [
                {fieldKey: 'buyer', targetKind: 'form.field'},
                {fieldKey: 'region', targetKind: 'form.field'},
            ],
            actions: [{actionIntent: 'submit', targetKind: 'form.action'}],
            columns: [],
            rowActions: [],
            supportedQueries: ['form.fields'],
        },
        {
            entityKey: 'orderList',
            businessTag: 'order.list',
            kind: 'table',
            fields: [{fieldKey: 'orderNo', targetKind: 'table.filter'}],
            actions: [{actionIntent: 'search', targetKind: 'table.module_action'}],
            columns: [{fieldKey: 'orderNo'}],
            rowActions: [{actionIntent: 'edit', targetKind: 'table.row_action'}],
            primaryKey: {fieldKey: 'orderNo'},
            supportedQueries: ['table.currentRows', 'table.rowCount'],
        },
    ],
};

const resolver: DslEntityRulesResolver = {
    resolveProfile: (profileName) => profileName === profile.profileName
        ? {profile, diagnostics: []}
        : {profile: null, diagnostics: []},
};

const resolveResolver: DslResolveResolver = {
    resolveBundle: (bundleName) => bundleName === 'main' || bundleName === 'secondary'
        ? {resolves: {dismissBanner: {hint: {raw: {selector: `#${bundleName}`}}} as any}, diagnostics: []}
        : {resolves: null, diagnostics: []},
};

test('parseDsl and linkDsl treat resolves as typed two-segment references with isolated runtime IDs', () => {
    const linked = linkDsl(parseDsl(`
use resolves "main" as recorded
use resolves "secondary" as other
click recorded.dismissBanner
fill other.dismissBanner with input.keyword
`), undefined, resolveResolver);

    assert.deepEqual(linked.diagnostics, []);
    assert.deepEqual(linked.program.imports, [
        {kind: 'resolves', bundleName: 'main', alias: 'recorded'},
        {kind: 'resolves', bundleName: 'secondary', alias: 'other'},
    ]);
    assert.equal((linked.program.body[0] as any).kind, 'resolve_act');
    assert.equal((linked.program.body[0] as any).resolveId, 'dsl:recorded:dismissBanner');
    assert.equal((linked.program.body[1] as any).resolveId, 'dsl:other:dismissBanner');
    assert.notEqual((linked.program.body[0] as any).resolveId, (linked.program.body[1] as any).resolveId);
    assert.deepEqual(Object.keys(linked.stepResolves).sort(), ['dsl:other:dismissBanner', 'dsl:recorded:dismissBanner']);
    assert.throws(
        () => parseDsl('use resolves "main" as recorded\nuse entity_rules "order-page" as recorded'),
        /duplicate entity_rules alias/,
    );
});

test('resolve bundle and symbol diagnostics are produced before execution', () => {
    const missingBundle = validateDslSource('use resolves "missing" as recorded\nclick recorded.dismissBanner', undefined, resolveResolver);
    const missingSymbol = validateDslSource('use resolves "main" as recorded\nclick recorded.unknown', undefined, resolveResolver);
    assert.equal(missingBundle.diagnostics[0]?.code, 'ERR_DSL_RESOLVE_BUNDLE_NOT_FOUND');
    assert.equal(missingSymbol.diagnostics[0]?.code, 'ERR_DSL_RESOLVE_SYMBOL_NOT_FOUND');
});

test('parseDsl keeps entity-rule imports out of executable statements and parses typed symbolic references', () => {
    const program = parseDsl(`
use entity_rules "order-page" as order
fill order.orderForm.buyer with input.buyer
let row = query order.orderList.row(input.orderNo)
click order.orderList.row(input.orderNo).edit
`);

    assert.deepEqual(program.imports, [{kind: 'entity_rules', profileName: 'order-page', alias: 'order'}]);
    assert.deepEqual(program.body.map((stmt) => stmt.kind), ['entity_act', 'let', 'entity_act']);
    assert.deepEqual((program.body[1] as any).expr.reference.rowValue, {kind: 'ref', ref: 'input.orderNo'});
    assert.throws(
        () => parseDsl('use entity_rules "order-page" as order\nuse entity_rules "other" as order'),
        /duplicate entity_rules alias/,
    );
});

test('linkDsl resolves typed fields, queries and row actions without generated scope variables', () => {
    const linked = linkDsl(parseDsl(`
use entity_rules "order-page" as order
type order.orderForm.buyer with input.buyer
select order.orderForm.region with input.region
let rows = query order.orderList.currentRows
click order.orderList.row(input.orderNo).edit
`), resolver);

    assert.deepEqual(linked.diagnostics, []);
    assert.deepEqual(linked.program.body[0], {
        kind: 'linked_entity_act',
        action: 'type',
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            profileName: 'order-page',
            payload: {kind: 'form.field', fieldKey: 'buyer'},
        },
        value: {kind: 'ref', ref: 'input.buyer'},
    });
    assert.equal(linked.program.body.some((stmt) => stmt.kind === 'let' && stmt.name.startsWith('dslEntityTarget')), false);
    assert.deepEqual((linked.program.body[2] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.list',
        payload: 'table.currentRows',
        profileName: 'order-page',
    });
    assert.deepEqual((linked.program.body[3] as any).targetQuery.payload, {
        kind: 'table.row_action',
        primaryKey: {fieldKey: 'orderNo', value: {kind: 'ref', ref: 'input.orderNo'}},
        actionIntent: 'edit',
    });
});

test('linkDsl reports profile export and primary-key problems before execution', () => {
    const missing = linkDsl(
        parseDsl('use entity_rules "missing" as order\nclick order.orderForm.submit'),
        resolver,
    );
    const invalidExport = linkDsl(
        parseDsl('use entity_rules "broken" as order\nclick order.orderForm.submit'),
        {
            resolveProfile: () => ({
                profile: null,
                diagnostics: [{code: 'ERR_DSL_ENTITY_EXPORT_INVALID', message: 'missing stable entityKey'}],
            }),
        },
    );
    const primaryKey = linkDsl(
        parseDsl('use entity_rules "order-page" as order\nlet row = query order.orderList.row(input.orderNo)'),
        {
            resolveProfile: () => ({
                profile: {
                    ...profile,
                    entities: [{...profile.entities[1], primaryKey: undefined}],
                },
                diagnostics: [],
            }),
        },
    );

    assert.equal(missing.diagnostics[0]?.code, 'ERR_DSL_ENTITY_PROFILE_NOT_FOUND');
    assert.equal(invalidExport.diagnostics[0]?.code, 'ERR_DSL_ENTITY_EXPORT_INVALID');
    assert.equal(primaryKey.diagnostics[0]?.code, 'ERR_DSL_ENTITY_PRIMARY_KEY_REQUIRED');
});

test('production provider adapter propagates non-exportable entity-rule diagnostics', () => {
    const artifact = {
        kind: 'entity_rules',
        name: 'legacy-orders',
        page: {kind: 'form'},
        match: {
            version: 2,
            rules: [{
                ruleId: 'orders-root',
                source: 'node',
                expect: 'unique',
                match: {kind: 'form'},
            }],
        },
        annotation: {
            version: 2,
            bindings: [{
                ruleId: 'orders-root',
                businessTag: 'orders.form',
                entityKind: 'form',
            }],
        },
    } as any;
    const workflow = {
        name: 'orders-workflow',
        get: (name: string) => name === artifact.name ? artifact : null,
        list: () => [{kind: 'entity_rules', name: artifact.name}],
    } as any;
    const resolver = createDslEntityRulesResolver(createWorkspaceEntityRulesProvider(workflow));

    const result = validateDslSource(
        'use entity_rules "legacy-orders" as order\nclick order.orderForm.submit',
        resolver,
    );

    assert.equal(result.diagnostics[0]?.code, 'ERR_DSL_ENTITY_EXPORT_INVALID');
    assert.match(result.diagnostics[0]?.message || '', /missing_entity_key/);
});

test('linkDsl validates table primary keys against columns, not filter fields', () => {
    const valid = linkDsl(
        parseDsl('use entity_rules "order-page" as order\nclick order.orderList.row(input.orderNo).edit'),
        resolver,
    );
    const duplicate = linkDsl(
        parseDsl('use entity_rules "order-page" as order\nclick order.orderList.row(input.orderNo).edit'),
        {
            resolveProfile: () => ({
                profile: {
                    ...profile,
                    entities: [{
                        ...profile.entities[1],
                        fields: [],
                        columns: [{fieldKey: 'orderNo'}, {fieldKey: 'orderNo'}],
                    }],
                },
                diagnostics: [],
            }),
        },
    );

    assert.deepEqual(valid.diagnostics, []);
    assert.deepEqual(duplicate.diagnostics.map((item) => item.code), ['ERR_DSL_ENTITY_PRIMARY_KEY_AMBIGUOUS']);
});

test('validateDslSource rejects undefined dynamic row references before a step executes', () => {
    const result = validateDslSource(
        'use entity_rules "order-page" as order\nclick order.orderList.row(vars.missing).edit',
        resolver,
    );

    assert.equal(result.diagnostics.some((item) => item.code === 'ERR_DSL_VAR_NOT_DEFINED'), true);
});

test('runDslSource uses strict explicit profile steps and runtime input for row actions', async () => {
    const calls: Array<{name: string; args: unknown; entityRules: unknown}> = [];
    const deps: RunStepsDeps = completeRunStepsDeps({
        runtime: {ensureActivePage: async () => ({workspaceName: 'ws', tabName: 'tab', traceCtx: {cache: {}}})},
        config: {} as any,
        resolveEntityRulesProvider: () => ({
            availability: 'ready',
            workflowName: 'ws',
            listProfiles: () => ['order-page'],
            getProfile: () => ({} as any),
            resolveExports: () => ({profileName: 'order-page', index: null, diagnostics: []}),
        }),
        pluginHost: {getExecutors: () => ({
            'browser.query': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args, entityRules: step.entityRules});
                const result: BrowserQueryResult = {kind: 'nodeId', nodeId: 'row-edit'};
                return {stepId: step.id, ok: true, data: result};
            },
            'browser.click': async (step: StepUnion) => {
                calls.push({name: step.name, args: step.args, entityRules: step.entityRules});
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
        }) as any} as any,
    }, {workspaceName: 'ws'});

    const result = await runDslSource(
        'use entity_rules "order-page" as order\nclick order.orderList.row(input.orderNo).edit',
        {workspaceName: 'ws', deps, input: {orderNo: 'SO-42'}, entityRulesResolver: resolver},
    );

    assert.equal(Object.keys(result.scope.vars).some((key) => key.startsWith('dslEntityTarget')), false);
    assert.deepEqual(calls, [
        {
            name: 'browser.query',
            args: {
                op: 'entity.target',
                businessTag: 'order.list',
                target: {
                    kind: 'table.row_action',
                    primaryKey: {fieldKey: 'orderNo', value: 'SO-42'},
                    actionIntent: 'edit',
                },
            },
            entityRules: {selection: 'explicit', profiles: ['order-page'], strict: true},
        },
        {
            name: 'browser.click',
            args: {nodeId: 'row-edit'},
            entityRules: {selection: 'explicit', profiles: ['order-page'], strict: true},
        },
    ]);
});
