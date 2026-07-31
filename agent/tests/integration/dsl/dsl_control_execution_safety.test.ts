import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslControl } from '../../../src/dsl/control';
import { ActionError } from '../../../src/actions/results';
import { toFailedAction } from '../../../src/actions/results';
import { DslValidationError } from '../../../src/dsl/diagnostics';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';
import type { StepUnion } from '../../../src/runner/steps/types';
import type { DslEntityRulesResolver } from '../../../src/dsl/link';

const createInput = (content: string, state: { value: 'idle' | 'executing' }, entityRulesResolver?: DslEntityRulesResolver) => {
    const workspace = {
        name: 'ws-dsl-control',
        get state() { return state.value; },
        set state(value) { state.value = value; },
        updatedAt: 0,
        workflow: {
            name: 'ws-dsl-control',
            entryDslName: () => 'main',
            list: () => [{ kind: 'dsl', name: 'main' }],
            get: () => ({ kind: 'dsl', name: 'main', content }),
            getDslEntityRulesResolver: () => entityRulesResolver,
        },
        checkpoint: { getProvider: () => ({ getCheckpoint: () => null }) },
    } as any;
    return (type: string) => ({
        action: { v: 1 as const, id: `${type}-id`, type, workspaceName: workspace.name },
        workspace,
        workspaceRegistry: {} as any,
    });
};

test('dsl.validate and compatibility dsl.test have zero execution side effects', async () => {
    let executions = 0;
    const control = createDslControl({
        runStepsDeps: completeRunStepsDeps({
            config: {} as any,
            pluginHost: { getExecutors: () => ({
                'browser.query': async (step: StepUnion) => {
                    executions += 1;
                    return { stepId: step.id, ok: true, data: { kind: 'value', value: [] } };
                },
            }) as any } as any,
        }),
    });
    const input = createInput('use entity_rules "orders" as order\nlet rows = query order.orderList.currentRows', { value: 'idle' }, {
        resolveProfile: (profileName) => profileName === 'orders' ? {
            profileName, entities: [{entityKey: 'orderList', businessTag: 'orders', kind: 'table', fields: [], actions: [], supportedQueries: ['table.currentRows']}],
        } : null,
    });

    const validate = await control.handle(input('dsl.validate'));
    const compatibility = await control.handle(input('dsl.test'));

    assert.equal(executions, 0);
    assert.equal((validate.reply.payload as { ok: boolean }).ok, true);
    assert.match(String((compatibility.reply.payload as { deprecated?: string }).deprecated), /validates only/);
});

test('dsl.run acquires one workspace execution slot and releases it after completion', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const control = createDslControl({
        runStepsDeps: completeRunStepsDeps({
            config: {} as any,
            pluginHost: { getExecutors: () => ({
                'browser.query': async (step: StepUnion) => {
                    await pending;
                    return { stepId: step.id, ok: true, data: { kind: 'value', value: [] } };
                },
            }) as any } as any,
        }),
    });
    const state = { value: 'idle' as const } as { value: 'idle' | 'executing' };
    const input = createInput('let rows = query table "orders" currentRows', state);
    const first = control.handle(input('dsl.run'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await assert.rejects(() => control.handle(input('dsl.run')), (error: unknown) =>
        error instanceof ActionError && error.code === 'ERR_BAD_STATE');
    release();
    await first;
    assert.equal(state.value, 'idle');
});

test('formal action failures preserve DSL error codes and diagnostics', () => {
    const failure = toFailedAction(
        { v: 1, id: 'dsl-error', type: 'dsl.run', workspaceName: 'ws-dsl-control' },
        new DslValidationError([{ code: 'ERR_DSL_VAR_NOT_DEFINED', message: 'buyer is missing', path: 'body.0.target' }]),
    );

    const payload = failure.payload as { code: string; details: unknown };
    assert.equal(payload.code, 'ERR_DSL_VALIDATION');
    assert.deepEqual(payload.details, {
        diagnostics: [{ code: 'ERR_DSL_VAR_NOT_DEFINED', message: 'buyer is missing', path: 'body.0.target' }],
    });
});
