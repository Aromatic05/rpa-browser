import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { linkDsl, type DslEntityRulesResolver } from '../../../src/dsl/link';
import { runDslSource } from '../../../src/dsl/runtime';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { BrowserQueryResult, StepUnion } from '../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';

const resolver: DslEntityRulesResolver = {
    resolveProfile: (profileName) => profileName === 'order-page' ? {
        profileName,
        entities: [
            {
                entityKey: 'orderForm', businessTag: 'order.form', kind: 'form',
                fields: [{fieldKey: 'buyer'}, {fieldKey: 'region'}],
                actions: [{actionIntent: 'submit'}], supportedQueries: ['form.fields'],
            },
            {
                entityKey: 'orderList', businessTag: 'order.list', kind: 'table',
                fields: [{fieldKey: 'orderNo'}], actions: [{actionIntent: 'search'}],
                rowActions: [{actionIntent: 'edit'}], primaryKey: {fieldKey: 'orderNo'},
                supportedQueries: ['table.currentRows', 'table.rowCount'],
            },
        ],
    } : null,
};

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
    assert.throws(() => parseDsl('use entity_rules "order-page" as order\nuse entity_rules "other" as order'), /duplicate entity_rules alias/);
});

test('linkDsl resolves fields, row actions, and dynamic primary-key values through the declared port', () => {
    const linked = linkDsl(parseDsl(`
use entity_rules "order-page" as order
select order.orderForm.region with input.region
let rows = query order.orderList.currentRows
click order.orderList.row(input.orderNo).edit
`), resolver);

    assert.deepEqual(linked.diagnostics, []);
    assert.deepEqual((linked.program.body[0] as any).expr, {
        kind: 'query', op: 'entity.target', businessTag: 'order.form', profileName: 'order-page',
        payload: {kind: 'form.field', fieldKey: 'region'},
    });
    assert.deepEqual((linked.program.body[2] as any).expr, {
        kind: 'query', op: 'entity', businessTag: 'order.list', payload: 'table.currentRows', profileName: 'order-page',
    });
    assert.deepEqual((linked.program.body[3] as any).expr.payload, {
        kind: 'table.row_action', primaryKey: {fieldKey: 'orderNo', value: {kind: 'ref', ref: 'input.orderNo'}}, actionIntent: 'edit',
    });
});

test('linkDsl reports profile and primary-key problems with symbol and statement paths', () => {
    const missing = linkDsl(parseDsl('use entity_rules "missing" as order\nclick order.orderForm.submit'), resolver);
    const primaryKey = linkDsl(parseDsl('use entity_rules "order-page" as order\nlet row = query order.orderList.row(input.orderNo)'), {
        resolveProfile: () => ({...resolver.resolveProfile('order-page')!, entities: [{...resolver.resolveProfile('order-page')!.entities[1], primaryKey: undefined}]}),
    });

    assert.deepEqual(missing.diagnostics[0], {
        code: 'ERR_DSL_ENTITY_PROFILE_NOT_FOUND',
        message: 'entity_rules profile not found: missing (alias order)',
        path: 'imports.0',
    });
    assert.equal(primaryKey.diagnostics[0].code, 'ERR_DSL_ENTITY_PRIMARY_KEY_REQUIRED');
    assert.match(primaryKey.diagnostics[0].path || '', /^body\.0\.expr/);
});

test('linkDsl rejects duplicate primary-key declarations deterministically', () => {
    const duplicate = linkDsl(parseDsl('use entity_rules "order-page" as order\nclick order.orderList.row(input.orderNo).edit'), {
        resolveProfile: () => ({...resolver.resolveProfile('order-page')!, entities: [{...resolver.resolveProfile('order-page')!.entities[1], fields: [{fieldKey: 'orderNo'}, {fieldKey: 'orderNo'}]}]}),
    });

    assert.deepEqual(duplicate.diagnostics.map((item) => item.code), ['ERR_DSL_ENTITY_PRIMARY_KEY_AMBIGUOUS']);
});

test('runDslSource uses strict explicit profile steps and runtime input for row actions', async () => {
    const calls: Array<{name: string; args: unknown; entityRules: unknown}> = [];
    const deps: RunStepsDeps = completeRunStepsDeps({
        runtime: {ensureActivePage: async () => ({workspaceName: 'ws', tabName: 'tab', traceCtx: {cache: {}}})},
        config: {} as any,
        resolveEntityRulesProvider: () => ({
            availability: 'ready', workflowName: 'ws', listProfiles: () => ['order-page'], getProfile: () => ({} as any),
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
    });

    await runDslSource('use entity_rules "order-page" as order\nclick order.orderList.row(input.orderNo).edit', {
        workspaceName: 'ws', deps, input: {orderNo: 'SO-42'}, entityRulesResolver: resolver,
    });

    assert.deepEqual(calls, [
        {
            name: 'browser.query',
            args: {op: 'entity.target', businessTag: 'order.list', target: {kind: 'table.row_action', primaryKey: {fieldKey: 'orderNo', value: 'SO-42'}, actionIntent: 'edit'}},
            entityRules: {selection: 'explicit', profiles: ['order-page'], strict: true},
        },
        {name: 'browser.click', args: {nodeId: 'row-edit'}, entityRules: {selection: 'explicit', profiles: ['order-page'], strict: true}},
    ]);
});
