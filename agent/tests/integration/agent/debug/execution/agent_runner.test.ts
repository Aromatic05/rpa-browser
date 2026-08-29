import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createPausedDslDebugAgentRunner} from '../../../../../src/agent/debug/execution/agent_runner';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage();
    const first = await store.ensureFresh({pageKey, pageUrl: '/orders', capture: async () => fixture.capture});
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const second = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const view = (entry: typeof first): WorldView => Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [view(first), view(second)];
};

test('continued DSL execution completes without invoking a debugger model when no pause is needed', async () => {
    const [view] = await createViews();
    const runner = createPausedDslDebugAgentRunner({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {value: 8},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'continue', breakOnFailure: true},
        modelRuntime: {resolve: () => null},
    });

    const result = await runner.run({
        provider: 'unused',
        model: 'unused',
        prompt: 'Run the program.',
    });

    assert.equal(result.execution.status, 'completed');
    assert.equal(result.text, '{"result":8}');
    assert.deepEqual(result.trace.metrics, {
        turns: 0,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
});

test('product barrier policy resumes normal statements without returning to step mode', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.cross_barrier', {})),
        fauxAssistantMessage('effect authorized and program completed'),
    ]);
    const [firstView, secondView] = await createViews();
    let live = firstView;
    let clickCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: 'click input.target\noutput done = input.done',
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    live = secondView;
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => live},
        debug: {
            initialMode: 'continue',
            barrierOn: ['unknown'],
            barrierResumeMode: 'continue',
            breakOnFailure: true,
        },
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Authorize the pending effect.',
    });

    assert.equal(result.execution.status, 'completed');
    assert.equal(result.text, 'effect authorized and program completed');
    assert.equal(clickCalls, 1);
    assert.equal(result.trace.metrics.turns, 2);
    assert.equal(result.trace.metrics.toolCalls, 1);
    assert.equal(result.trace.tools[0].toolName, 'debug.cross_barrier');
    assert.equal(result.session.auditEffects().length, 1);
});

test('paused DSL Agent runner lets the model inspect, step and continue a retained execution', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.execution', {})),
        fauxAssistantMessage(fauxToolCall('debug.scope', {})),
        fauxAssistantMessage(fauxToolCall('debug.step', {})),
        fauxAssistantMessage(fauxToolCall('debug.execution', {})),
        fauxAssistantMessage(fauxToolCall('debug.continue', {})),
        fauxAssistantMessage('execution complete'),
    ]);
    const [firstView, secondView] = await createViews();
    let live = firstView;
    let snapshotCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: `
            snapshot
            output result = input.value
        `,
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {value: 8},
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name === 'browser.snapshot') {
                        snapshotCalls += 1;
                        live = secondView;
                    }
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => live},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Inspect and finish the paused execution.',
    });

    assert.equal(result.text, 'execution complete');
    assert.equal(result.execution.status, 'completed');
    assert.equal(snapshotCalls, 1);
    assert.deepEqual(result.trace.metrics, {
        turns: 6,
        toolCalls: 5,
        readCalls: 3,
        controlCalls: 2,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });

    const step = result.trace.tools.find((tool) => tool.toolName === 'debug.step')!;
    assert.equal(step.classification, 'control');
    assert.equal(step.worldBefore?.captureRevision, 1);
    assert.equal(step.worldAfter?.captureRevision, 2);
    const continueCall = result.trace.tools.find((tool) => tool.toolName === 'debug.continue')!;
    assert.equal(continueCall.classification, 'control');
    assert.equal(continueCall.worldBefore?.captureRevision, 2);
    assert.equal(continueCall.worldAfter, null);
});

test('paused DSL Agent runner preserves a structured failed terminal state after failure inspection', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.execution', {})),
        fauxAssistantMessage(fauxToolCall('debug.query', {
            op: 'entity',
            businessTag: 'order.table.main',
            query: 'table.rowCount',
        })),
        fauxAssistantMessage(fauxToolCall('debug.continue', {})),
        fauxAssistantMessage('failure inspected'),
    ]);
    const [view] = await createViews();
    let clickCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'missing-button'}},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_NOT_FOUND', message: 'missing button', details: {matches: 0}},
                    };
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Inspect the failure and finish.',
    });

    assert.equal(result.text, 'failure inspected');
    assert.equal(result.execution.status, 'failed');
    if (result.execution.status !== 'failed') {throw new Error('expected failed execution');}
    assert.equal(result.execution.failure.code, 'ERR_NOT_FOUND');
    assert.equal(result.execution.failure.stepName, 'browser.click');
    assert.equal(clickCalls, 1);
    assert.deepEqual(result.trace.metrics, {
        turns: 4,
        toolCalls: 3,
        readCalls: 2,
        controlCalls: 1,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
});

test('paused DSL Agent runner can abort before a pending World effect', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.execution', {})),
        fauxAssistantMessage(fauxToolCall('debug.abort', {})),
        fauxAssistantMessage('execution aborted'),
    ]);
    const [view] = await createViews();
    let clickCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'dangerous-button'}},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Inspect the pending effect and abort it.',
    });

    assert.equal(result.text, 'execution aborted');
    assert.equal(result.execution.status, 'aborted');
    assert.equal(clickCalls, 0);
    assert.deepEqual(result.trace.metrics, {
        turns: 3,
        toolCalls: 2,
        readCalls: 1,
        controlCalls: 1,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
});

test('paused DSL Agent runner exposes executed effects as a pure journal read', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.effects', {})),
        fauxAssistantMessage(fauxToolCall('debug.step', {})),
        fauxAssistantMessage(fauxToolCall('debug.effects', {})),
        fauxAssistantMessage(fauxToolCall('debug.diff', {effectSequence: 1})),
        fauxAssistantMessage('journal inspected'),
    ]);
    const [firstView, secondView] = await createViews();
    let revision = 1;
    let clickCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: `
            click input.target
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    revision = 2;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => revision === 1 ? firstView : secondView},
        debug: {breakBeforeEffects: true},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Inspect the effect journal before and after one step.',
    });

    assert.equal(result.text, 'journal inspected');
    assert.equal(result.execution.status, 'paused');
    if (result.execution.status !== 'paused') {throw new Error('expected paused execution');}
    assert.equal(result.execution.pause.location.path, 'body.1');
    assert.equal(clickCalls, 1);
    const effects = result.session.effects(result.execution.pause.continuationId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.stepName, 'browser.click');
    assert.equal(effects[0].worldBefore.revision.captureRevision, 1);
    assert.equal(effects[0].worldAfter.revision.captureRevision, 2);
    assert.deepEqual(result.trace.metrics, {
        turns: 5,
        toolCalls: 4,
        readCalls: 3,
        controlCalls: 1,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });

    const aborted = await result.session.advance(result.execution.pause.continuationId, 'abort');
    assert.equal(aborted.status, 'aborted');
});
test('paused DSL Agent runner handles World conflict through pure refresh before retrying advance', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.continue', {})),
        fauxAssistantMessage(fauxToolCall('debug.refresh', {})),
        fauxAssistantMessage(fauxToolCall('debug.query', {
            op: 'entity',
            businessTag: 'order.table.main',
            query: 'table.rowCount',
        })),
        fauxAssistantMessage(fauxToolCall('debug.continue', {})),
        fauxAssistantMessage('world refreshed'),
    ]);
    const [firstView, secondView] = await createViews();
    let pinCalls = 0;
    const runner = createPausedDslDebugAgentRunner({
        source: 'output result = input.value',
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {value: 12},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => pinCalls++ === 0 ? firstView : secondView},
        debug: {initialMode: 'step'},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Handle a World conflict by refreshing and inspecting before continuing.',
    });

    assert.equal(result.text, 'world refreshed');
    assert.equal(result.execution.status, 'completed');
    assert.deepEqual(result.trace.metrics, {
        turns: 5,
        toolCalls: 4,
        readCalls: 2,
        controlCalls: 2,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
    const continueCalls = result.trace.tools.filter((tool) => tool.toolName === 'debug.continue');
    assert.equal(continueCalls.length, 2);
    assert.equal(continueCalls[0].worldBefore?.captureRevision, 1);
    assert.equal(continueCalls[0].worldAfter?.captureRevision, 1);
    const refresh = result.trace.tools.find((tool) => tool.toolName === 'debug.refresh')!;
    assert.equal(refresh.classification, 'read');
    assert.equal(refresh.worldBefore?.captureRevision, 1);
    assert.equal(refresh.worldAfter?.captureRevision, 2);
    assert.equal(continueCalls[1].worldBefore?.captureRevision, 2);
    assert.equal(continueCalls[1].worldAfter, null);
});
test('paused DSL Agent runner inspects invariant failure without any World effect', async () => {
    const faux = createFauxCore({provider: 'faux-debugger', models: [{id: 'debugger'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('debug.execution', {})),
        fauxAssistantMessage(fauxToolCall('debug.compute', {
            expr: {
                op: 'eq',
                args: [
                    {ref: {path: 'input.actual'}},
                    {ref: {path: 'input.expected'}},
                ],
            },
        })),
        fauxAssistantMessage(fauxToolCall('debug.effects', {})),
        fauxAssistantMessage(fauxToolCall('debug.continue', {})),
        fauxAssistantMessage('invariant inspected'),
    ]);
    const [view] = await createViews();
    const runner = createPausedDslDebugAgentRunner({
        source: `
            ensure compute eq(input.actual, input.expected)
            click input.target
        `,
        context: {
            workspaceName: 'ws-1',
            deps: {} as RunStepsDeps,
            input: {actual: 1, expected: 2, target: {nodeId: 'submit'}},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux-debugger' && model === 'debugger'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        provider: 'faux-debugger',
        model: 'debugger',
        prompt: 'Inspect the invariant failure and terminalize it.',
    });

    assert.equal(result.text, 'invariant inspected');
    assert.equal(result.execution.status, 'failed');
    if (result.execution.status !== 'failed') {throw new Error('expected failed execution');}
    assert.equal(result.execution.failure.code, 'ERR_DSL_ENSURE_FAILED');
    assert.deepEqual(result.trace.metrics, {
        turns: 5,
        toolCalls: 4,
        readCalls: 3,
        controlCalls: 1,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });
});
