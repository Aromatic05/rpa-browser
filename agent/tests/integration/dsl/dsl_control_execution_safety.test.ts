import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslControl } from '../../../src/dsl/control';
import { ActionError, toFailedAction } from '../../../src/actions/results';
import { DslValidationError } from '../../../src/dsl/diagnostics';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';
import type { StepUnion } from '../../../src/runner/steps/types';
import type { EntityRuleExportIndex } from '../../../src/workflow';

const exportIndex: EntityRuleExportIndex = {
    profileName: 'orders',
    entities: [{
        profileName: 'orders',
        entityKey: 'orderList',
        businessTag: 'orders',
        kind: 'table',
        fields: [],
        actions: [],
        columns: [{fieldKey: 'orderNo'}],
        rowActions: [{actionIntent: 'edit', targetKind: 'table.row_action'}],
        supportedQueries: ['table.currentRows'],
        primaryKey: {fieldKey: 'orderNo', columns: ['orderNo']},
        members: [
            {kind: 'query', symbol: 'currentRows'},
            {kind: 'rowAction', symbol: 'edit', rowPrimaryKey: 'orderNo'},
        ],
    }],
    resolve: (_entityKey, symbol) => symbol === 'currentRows'
        ? {kind: 'query', symbol: 'currentRows'}
        : undefined,
};

const createEntityRulesProvider = () => ({
    availability: 'ready' as const,
    workflowName: 'ws-dsl-control',
    listProfiles: () => ['orders'],
    getProfile: () => ({} as any),
    resolveExports: (profileName: string) => profileName === 'orders'
        ? {profileName, index: exportIndex, diagnostics: []}
        : {
            profileName,
            index: null,
            diagnostics: [{
                code: 'entity_rule_exports.profile_not_found' as const,
                message: `profile not found: ${profileName}`,
                profileName,
            }],
        },
});

const createInput = (
    content: string,
    state: {value: 'idle' | 'executing'},
    options: {save?: (value: unknown) => void} = {},
) => {
    const workspace = {
        name: 'ws-dsl-control',
        get state() {return state.value;},
        set state(value) {state.value = value;},
        updatedAt: 0,
        workflow: {
            name: 'ws-dsl-control',
            entryDslName: () => 'main',
            list: () => [{kind: 'dsl', name: 'main'}],
            get: () => ({kind: 'dsl', name: 'main', content}),
            save: options.save ?? (() => undefined),
        },
        checkpoint: {getProvider: () => ({getCheckpoint: () => null})},
        entityRules: {getProvider: () => createEntityRulesProvider()},
    } as any;
    return (type: string, payload?: Record<string, unknown>) => ({
        action: {
            v: 1 as const,
            id: `${type}-id`,
            type,
            workspaceName: workspace.name,
            ...(payload ? {payload} : {}),
        },
        workspace,
        workspaceRegistry: {} as any,
    });
};

test('dsl.validate and compatibility dsl.test have zero execution side effects', async () => {
    let executions = 0;
    const control = createDslControl({
        runStepsDeps: completeRunStepsDeps({
            config: {} as any,
            pluginHost: {getExecutors: () => ({
                'browser.query': async (step: StepUnion) => {
                    executions += 1;
                    return {stepId: step.id, ok: true, data: {kind: 'value', value: []}};
                },
            }) as any} as any,
        }, {workspaceName: 'ws-dsl-control'}),
    });
    const input = createInput(
        'use entity_rules "orders" as order\nlet rows = query order.orderList.currentRows',
        {value: 'idle'},
    );

    const validate = await control.handle(input('dsl.validate'));
    const compatibility = await control.handle(input('dsl.test'));

    assert.equal(executions, 0);
    assert.equal((validate.reply.payload as {ok: boolean}).ok, true);
    assert.match(String((compatibility.reply.payload as {deprecated?: string}).deprecated), /validates only/);
});

test('dsl.save validates imports and references before persistence', async () => {
    const saved: unknown[] = [];
    const control = createDslControl({
        runStepsDeps: completeRunStepsDeps({}, {workspaceName: 'ws-dsl-control'}),
    });
    const input = createInput('wait 1', {value: 'idle'}, {save: (value) => saved.push(value)});

    await assert.rejects(
        () => control.handle(input('dsl.save', {
            content: 'use entity_rules "orders" as order\nclick order.orderList.row(vars.missing).edit',
        })),
        (error: unknown) => error instanceof DslValidationError
            && error.diagnostics.some((diagnostic) => diagnostic.code === 'ERR_DSL_VAR_NOT_DEFINED'),
    );
    assert.deepEqual(saved, []);
});

test('dsl.run acquires one workspace execution slot and releases it after completion', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {release = resolve;});
    const control = createDslControl({
        runStepsDeps: completeRunStepsDeps({
            config: {} as any,
            pluginHost: {getExecutors: () => ({
                'browser.query': async (step: StepUnion) => {
                    await pending;
                    return {stepId: step.id, ok: true, data: {kind: 'value', value: []}};
                },
            }) as any} as any,
        }, {workspaceName: 'ws-dsl-control'}),
    });
    const state = {value: 'idle' as const} as {value: 'idle' | 'executing'};
    const input = createInput('let rows = query table "orders" currentRows', state);
    const first = control.handle(input('dsl.run'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await assert.rejects(
        () => control.handle(input('dsl.run')),
        (error: unknown) => error instanceof ActionError && error.code === 'ERR_BAD_STATE',
    );
    release();
    await first;
    assert.equal(state.value, 'idle');
});

test('dsl.run freezes the referenced procedure graph before executing earlier DSL steps', async () => {
    let body = 'use resolves "bundle" as target\nclick target.button';
    let selector = '#frozen';
    const calls: string[] = [];
    const checkpoint = {id: 'procedure', kind: 'procedure' as const, body: {language: 'dsl' as const, source: 'body.dsl'}};
    const workspace = {
        name: 'ws-dsl-control', state: 'idle' as 'idle' | 'executing', updatedAt: 0,
        workflow: {
            name: 'ws-dsl-control', entryDslName: () => 'main',
            list: () => {throw new Error('workflow.list must not enumerate unrelated DSL artifacts');},
            get: (name: string) => name === 'main'
                ? {kind: 'dsl', name, content: 'click input.seed\nuse checkpoint "procedure"', stepResolves: {}}
                : name === 'bundle' ? {kind: 'dsl', name, content: '', stepResolves: {button: {hint: {raw: {selector}}}}} : null,
        },
        checkpoint: {getProvider: () => ({
            getCheckpoint: (id: string) => id === checkpoint.id ? checkpoint : null,
            getCheckpointResolves: () => ({}),
            getCheckpointBody: () => ({source: body, stepResolves: {}}),
            listCheckpoints: () => [],
        })},
    } as any;
    const deps = completeRunStepsDeps({
        config: {} as any,
        resolveWorkspace: () => workspace,
        pluginHost: {getExecutors: () => ({
            'browser.click': async (step: StepUnion) => {
                if (calls.length === 0) {body = 'click input.missing'; selector = '#live';}
                calls.push(String(step.resolve?.hint?.raw?.selector || (step.args as any).nodeId));
                return {stepId: step.id, ok: true};
            },
        }) as any} as any,
    }, {workspaceName: workspace.name});
    const control = createDslControl({runStepsDeps: deps});
    const result = await control.handle({
        action: {v: 1, id: 'frozen-procedure', type: 'dsl.run', workspaceName: workspace.name, payload: {input: {seed: {nodeId: 'seed'}}}},
        workspace, workspaceRegistry: {} as any,
    });
    assert.equal(result.reply.type, 'dsl.run.result');
    assert.deepEqual(calls, ['seed', '#frozen']);
});

test('formal action failures preserve DSL error codes and diagnostics', () => {
    const failure = toFailedAction(
        {v: 1, id: 'dsl-error', type: 'dsl.run', workspaceName: 'ws-dsl-control'},
        new DslValidationError([{
            code: 'ERR_DSL_VAR_NOT_DEFINED',
            message: 'buyer is missing',
            path: 'body.0.target',
        }]),
    );

    const payload = failure.payload as {code: string; details: unknown};
    assert.equal(payload.code, 'ERR_DSL_VALIDATION');
    assert.deepEqual(payload.details, {
        diagnostics: [{
            code: 'ERR_DSL_VAR_NOT_DEFINED',
            message: 'buyer is missing',
            path: 'body.0.target',
        }],
    });
});
