import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
import type {WorldView, WorldViewSource} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import type {RuntimeStateRecord} from '../../../../../src/snapshot/observation/model/contracts';
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

const withRuntimeValue = (
    view: WorldView,
    nodeId: string,
    value: string,
    captureRevision: number,
): WorldView => {
    const entry = structuredClone(view.entry);
    const runtimeState = entry.capture.control.observation.runtimeState as unknown as Record<
        string,
        RuntimeStateRecord | undefined
    >;
    runtimeState[nodeId] = {stateId: `state:${nodeId}`, value};
    const identity = entry.capture.control.observation.identity as unknown as {captureRevision: number};
    identity.captureRevision = captureRevision;
    return Object.freeze({
        ...view,
        revision: Object.freeze({...view.revision, captureRevision}),
        entry,
    });
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
        'debug.explain',
        'debug.effects',
        'debug.diff',
        'debug.transaction',
        'debug.transaction_diff',
        'debug.savepoint',
        'debug.rollback',
        'debug.world',
        'debug.refresh',
        'debug.query',
        'debug.compute',
        'debug.cross_barrier',
        'debug.step',
        'debug.continue',
        'debug.abort',
    ]);
    for (const name of ['debug.execution', 'debug.scope', 'debug.explain', 'debug.effects', 'debug.diff', 'debug.transaction', 'debug.transaction_diff', 'debug.world', 'debug.refresh', 'debug.query', 'debug.compute']) {
        assert.equal(classifyPausedDslDebugToolCall(name), 'read');
    }
    assert.equal(classifyPausedDslDebugToolCall('debug.savepoint'), 'control');
    assert.equal(classifyPausedDslDebugToolCall('debug.rollback'), 'control');
    assert.equal(classifyPausedDslDebugToolCall('debug.cross_barrier'), 'control');
    assert.equal(classifyPausedDslDebugToolCall('debug.step'), 'control');
    assert.equal(classifyPausedDslDebugToolCall('debug.continue'), 'control');
    assert.equal(classifyPausedDslDebugToolCall('debug.abort'), 'control');

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
    const savepointTool = debuggerTools.tools.find((tool) => tool.name === 'debug.savepoint')!;
    const saved = await savepointTool.execute('savepoint-1', {name: 'before-snapshot'});
    assert.equal((saved.details as any).savepoint.effectSequence, 0);
    assert.equal((saved.details as any).savepoint.name, 'before-snapshot');
    const rollbackTool = debuggerTools.tools.find((tool) => tool.name === 'debug.rollback')!;
    const rollback = await rollbackTool.execute('rollback-1', {
        savepointId: (saved.details as any).savepoint.id,
    });
    assert.equal((rollback.details as any).status, 'restored');
    assert.equal((rollback.details as any).mode, 'noop');
    const transactionTool = debuggerTools.tools.find((tool) => tool.name === 'debug.transaction')!;
    const transaction = await transactionTool.execute('transaction-1', {});
    assert.equal((transaction.details as any).transaction.effectCount, 0);
    assert.equal((transaction.details as any).transaction.savepoints.length, 1);
    const transactionDiff = debuggerTools.tools.find((tool) => tool.name === 'debug.transaction_diff')!;
    const delta = await transactionDiff.execute('transaction-diff-1', {});
    assert.equal((delta.details as any).ok, true);
    assert.equal((delta.details as any).worldBefore.revision.captureRevision, 1);
    assert.equal((delta.details as any).worldAfter.revision.captureRevision, 1);

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

test('debug.rollback exposes physical compensation as control and refreshes the paused World', async () => {
    const [base] = await createViews();
    const before = withRuntimeValue(base, 'buyer-input', 'old value', 1);
    const afterFill = withRuntimeValue(base, 'buyer-input', 'new value', 2);
    const afterCompensation = withRuntimeValue(base, 'buyer-input', 'old value', 3);
    let current = before;
    const values: string[] = [];
    const port = {
        execute: async (step: Parameters<NonNullable<Parameters<typeof createDslDebugExecutionSession>[0]['context']['stepExecutionPort']>['execute']>[0]) => {
            if (step.name !== 'browser.fill') {throw new Error(`unexpected step: ${step.name}`);}
            values.push(step.args.value);
            current = step.args.value === 'new value' ? afterFill : afterCompensation;
            return {stepId: step.id, ok: true, data: {filled: true}};
        },
    };
    const execution = createDslDebugExecutionSession({
        source: `
            fill input.target with input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {target: {nodeId: 'buyer-input'}, value: 'new value', done: true},
            stepExecutionPort: port,
        },
        compensationPort: port,
        worldViewSource: {pin: async () => current},
        debug: {breakBeforeEffects: true, breakpoints: ['body.1']},
    });
    const beforeEffect = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, beforeEffect);
    const savepointTool = tools.tools.find((tool) => tool.name === 'debug.savepoint')!;
    const saved = await savepointTool.execute('savepoint-physical', {name: 'before-fill'});
    const continueTool = tools.tools.find((tool) => tool.name === 'debug.continue')!;
    const afterEffect = await continueTool.execute('continue-fill', {});
    assert.equal((afterEffect.details as any).status, 'paused');
    assert.deepEqual(values, ['new value']);

    const rollbackTool = tools.tools.find((tool) => tool.name === 'debug.rollback')!;
    const rollback = await rollbackTool.execute('rollback-physical', {
        savepointId: (saved.details as any).savepoint.id,
        strategy: 'physical',
    });
    assert.equal((rollback.details as any).status, 'compensated');
    assert.equal((rollback.details as any).mode, 'physical');
    assert.equal((rollback.details as any).semanticRisk, 'unknown');
    assert.deepEqual(values, ['new value', 'old value']);
    assert.equal(classifyPausedDslDebugToolCall('debug.rollback'), 'control');
    assert.equal(tools.readPause()?.world.revision.captureRevision, 3);

    const pause = tools.readPause();
    if (!pause) {throw new Error('expected retained pause after compensation');}
    const effects = execution.effects(pause.continuationId);
    assert.equal(effects.length, 2);
    assert.deepEqual(effects[1].compensates, {effectSequence: 1});
    assert.equal(effects[1].outcome.status, 'succeeded');

    await execution.advance(pause.continuationId, 'abort');
});

test('commit barrier remains paused under continue and only debug.cross_barrier authorizes the effect', async () => {
    const [view] = await createViews();
    const calls: string[] = [];
    const execution = createDslDebugExecutionSession({
        source: `
            use entity_rules "orders" as order
            click order.orderForm.submit
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {done: true},
            entityRulesResolver: {
                resolveProfile: () => ({
                    diagnostics: [],
                    profile: {
                        profileName: 'orders',
                        entities: [{
                            entityKey: 'orderForm',
                            businessTag: 'order.form',
                            kind: 'form',
                            fields: [],
                            actions: [{
                                actionIntent: 'submit',
                                targetKind: 'form.action',
                                effect: {reversibility: 'irreversible'},
                            }],
                            columns: [],
                            rowActions: [],
                            supportedQueries: [],
                        }],
                    },
                }),
            },
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(step.name);
                    return step.name === 'browser.query'
                        ? {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit'}}
                        : {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {barrierOn: ['irreversible']},
    });

    const barrier = await execution.waitForPause();
    assert.equal(barrier.reason, 'barrier');
    if (barrier.reason !== 'barrier') {throw new Error('expected barrier pause');}
    const tools = createPausedDslDebugAgentTools(execution, barrier);
    const continueTool = tools.tools.find((tool) => tool.name === 'debug.continue')!;
    const blocked = await continueTool.execute('continue-barrier', {});
    assert.equal((blocked.details as any).status, 'barrier');
    assert.equal(tools.readPause()?.continuationId, barrier.continuationId);
    assert.deepEqual(calls, ['browser.query']);

    const cross = tools.tools.find((tool) => tool.name === 'debug.cross_barrier')!;
    const crossed = await cross.execute('cross-barrier', {});
    assert.equal((crossed.details as any).status, 'paused');
    assert.equal((crossed.details as any).pause.location.path, 'body.1');
    assert.deepEqual(calls, ['browser.query', 'browser.click']);
    assert.equal(classifyPausedDslDebugToolCall('debug.cross_barrier'), 'control');

    const pause = tools.readPause();
    if (!pause) {throw new Error('expected pause after crossing barrier');}
    const effects = execution.effects(pause.continuationId);
    assert.equal(effects.length, 1);
    assert.equal(effects[0].effect.semantics.reversibility, 'irreversible');
    await execution.advance(pause.continuationId, 'abort');
});

test('debug.cross_barrier refuses stale World approval until the debugger refreshes', async () => {
    const [firstView, secondView] = await createViews();
    let current = firstView;
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            use entity_rules "orders" as order
            click order.orderForm.submit
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            input: {done: true},
            entityRulesResolver: {
                resolveProfile: () => ({
                    diagnostics: [],
                    profile: {
                        profileName: 'orders',
                        entities: [{
                            entityKey: 'orderForm',
                            businessTag: 'order.form',
                            kind: 'form',
                            fields: [],
                            actions: [{
                                actionIntent: 'submit',
                                targetKind: 'form.action',
                                effect: {reversibility: 'irreversible'},
                            }],
                            columns: [],
                            rowActions: [],
                            supportedQueries: [],
                        }],
                    },
                }),
            },
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name === 'browser.query') {
                        return {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'submit'}};
                    }
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => current},
        debug: {barrierOn: ['irreversible']},
    });

    const barrier = await execution.waitForPause();
    assert.equal(barrier.reason, 'barrier');
    current = secondView;
    const stale = await execution.crossBarrier(barrier.continuationId);
    assert.equal(stale.status, 'conflict');
    if (stale.status !== 'conflict') {throw new Error('expected World conflict');}
    assert.equal(stale.conflict.expected.revision.captureRevision, 1);
    assert.equal(stale.conflict.actual.revision.captureRevision, 2);
    assert.equal(clickCalls, 0);

    const refreshed = await execution.refresh(barrier.continuationId);
    assert.equal(refreshed.reason, 'barrier');
    assert.equal(refreshed.world.revision.captureRevision, 2);
    const crossed = await execution.crossBarrier(barrier.continuationId);
    assert.equal(crossed.status, 'paused');
    assert.equal(clickCalls, 1);
    if (crossed.status !== 'paused') {throw new Error('expected pause after barrier effect');}
    await execution.advance(crossed.pause.continuationId, 'abort');
});

test('debug.explain recursively traces a derived value back through query provenance', async () => {
    const [view] = await createViews();
    const execution = createDslDebugExecutionSession({
        source: `
            let buyer = query entity.target "order.form" {
              kind: "form.field"
              fieldKey: "buyer"
            }
            let present = compute exists(buyer)
            output selected = buyer
            wait 0
        `,
        context: {
            workspaceName: 'ws-1',
            deps,
            stepExecutionPort: {
                execute: async (step) => step.name === 'browser.query'
                    ? {
                        stepId: step.id,
                        ok: true,
                        data: {
                            kind: 'nodeId',
                            nodeId: 'buyer-input',
                            meta: {pageEpoch: 'v2-business', captureRevision: 1},
                        },
                    }
                    : {stepId: step.id, ok: true, data: {}},
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakpoints: ['body.3']},
    });

    const pause = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const explain = tools.tools.find((tool) => tool.name === 'debug.explain')!;
    const explained = await explain.execute('explain-present', {path: 'vars.present'});
    const tree = (explained.details as any).explanation;

    assert.equal(tree.path, 'vars.present');
    assert.equal(tree.origin, 'derived');
    assert.equal(tree.provenance.source.kind, 'compute');
    assert.deepEqual(tree.provenance.source.dependencies, ['vars.buyer']);
    assert.equal(tree.dependencies.length, 1);
    assert.equal(tree.dependencies[0].path, 'vars.buyer');
    assert.equal(tree.dependencies[0].provenance.source.kind, 'query');
    assert.deepEqual(tree.dependencies[0].provenance.source.observedAt, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
    });
    assert.equal(classifyPausedDslDebugToolCall('debug.explain'), 'read');
    assert.equal((explained.details as any).world.revision.captureRevision, 1);

    await execution.advance(pause.continuationId, 'abort');
});
