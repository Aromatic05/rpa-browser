import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
import type {WorldView, WorldViewSource} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import type {RunStepsDeps} from '../../../../../src/runner/run_steps';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const deps = {} as RunStepsDeps;

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage();
    const first = await store.ensureFresh({pageKey, pageUrl: '/orders', capture: async () => fixture.capture});
    const nextCapture = structuredClone(fixture.capture);
    nextCapture.control.observation.identity.captureRevision = 2;
    const second = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => nextCapture,
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

test('paused DSL Agent tools split pure debugger reads from execution effects', async () => {
    const [firstView, secondView] = await createViews();
    let live = firstView;
    let snapshotCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            snapshot
            output result = input.value
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {value: 6},
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
        worldViewSource: {pin: async () => live} satisfies WorldViewSource,
        debug: {initialMode: 'step'},
    });
    const firstPause = await execution.waitForPause();
    const debuggerTools = createPausedDslDebugAgentTools(execution, firstPause);
    assert.deepEqual(firstPause.location.source, {line: 2, column: 1, endLine: 2, endColumn: 9});
    assert.deepEqual(firstPause.location.callStack, []);

    assert.deepEqual(debuggerTools.tools.map((tool) => tool.name), [
        'debug.execution',
        'debug.scope',
        'debug.effects',
        'debug.world',
        'debug.refresh',
        'debug.query',
        'debug.compute',
        'debug.step',
        'debug.continue',
        'debug.abort',
    ]);
    for (const name of ['debug.execution', 'debug.scope', 'debug.effects', 'debug.world', 'debug.refresh', 'debug.query', 'debug.compute']) {
        assert.equal(classifyPausedDslDebugToolCall(name), 'read');
    }
    assert.equal(classifyPausedDslDebugToolCall('debug.step'), 'effect');
    assert.equal(classifyPausedDslDebugToolCall('debug.continue'), 'effect');
    assert.equal(classifyPausedDslDebugToolCall('debug.abort'), 'effect');

    const compute = debuggerTools.tools.find((tool) => tool.name === 'debug.compute')!;
    const computed = await compute.execute('compute-1', {
        expr: {
            op: 'eq',
            args: [
                {ref: {path: 'input.value'}},
                {literal: 6},
            ],
        },
    });
    assert.equal((computed.details as any).value, true);
    assert.equal((computed.details as any).world.revision.captureRevision, 1);
    const effects = debuggerTools.tools.find((tool) => tool.name === 'debug.effects')!;
    const effectResult = await effects.execute('effects-1', {});
    assert.deepEqual((effectResult.details as any).effects, []);

    const step = debuggerTools.tools.find((tool) => tool.name === 'debug.step')!;
    const stepped = await step.execute('step-1', {});
    assert.equal((stepped.details as any).status, 'paused');
    assert.equal((stepped.details as any).pause.location.path, 'body.1');
    assert.equal((stepped.details as any).pause.world.revision.captureRevision, 2);
    assert.equal(snapshotCalls, 1);
    assert.deepEqual(debuggerTools.readWorldRevision(), {
        pageEpoch: 'v2-business',
        captureRevision: 2,
        freshness: 'fresh',
    });

    const continueTool = debuggerTools.tools.find((tool) => tool.name === 'debug.continue')!;
    const completed = await continueTool.execute('continue-1', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 6});
    assert.equal(snapshotCalls, 1);
});

test('debug.execution exposes a pending effect before Agent continuation executes it', async () => {
    const [view] = await createViews();
    const calls: string[] = [];
    const execution = createDslDebugExecutionSession({
        source: `
            let target = query entity.target "orders.main" {
              kind: "table.module_action"
              actionIntent: "approve"
            }
            click target
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(step.name);
                    if (step.name === 'browser.query') {
                        return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'approve-button'}};
                    }
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
    });
    const firstPause = await execution.waitForPause();
    const debuggerTools = createPausedDslDebugAgentTools(execution, firstPause);
    const inspect = debuggerTools.tools.find((tool) => tool.name === 'debug.execution')!;
    const inspected = await inspect.execute('inspect-effect', {});

    assert.equal((inspected.details as any).pause.reason, 'effect');
    assert.equal((inspected.details as any).pause.effect.stepName, 'browser.click');
    assert.deepEqual((inspected.details as any).pause.effect.args, {nodeId: 'approve-button'});
    assert.deepEqual((inspected.details as any).pause.location.source, {
        line: 6,
        column: 1,
        endLine: 6,
        endColumn: 13,
    });
    assert.deepEqual((inspected.details as any).pause.location.callStack, []);
    assert.deepEqual(calls, ['browser.query']);

    const continueTool = debuggerTools.tools.find((tool) => tool.name === 'debug.continue')!;
    const completed = await continueTool.execute('continue-effect', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual(calls, ['browser.query', 'browser.click']);
});
