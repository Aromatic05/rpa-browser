import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall} from '@earendil-works/pi-ai';
import {createPausedDslDebugAgentRunner} from '../../../../../src/agent/debug/execution/agent_runner';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import type {RunStepsDeps} from '../../../../../src/runner/run_steps';
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
    const views = [firstView, secondView];
    let pinIndex = 0;
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
                    if (step.name === 'browser.snapshot') {snapshotCalls += 1;}
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => views[pinIndex++] ?? secondView},
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
        effectCalls: 2,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    });

    const step = result.trace.tools.find((tool) => tool.toolName === 'debug.step')!;
    assert.equal(step.classification, 'effect');
    assert.equal(step.worldBefore?.captureRevision, 1);
    assert.equal(step.worldAfter?.captureRevision, 2);
    const continueCall = result.trace.tools.find((tool) => tool.toolName === 'debug.continue')!;
    assert.equal(continueCall.classification, 'effect');
    assert.equal(continueCall.worldBefore?.captureRevision, 2);
    assert.equal(continueCall.worldAfter, null);
});
