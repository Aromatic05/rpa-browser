import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {
    compactDebuggerSystemPromptForPause,
    debuggerSystemPromptForPause,
} from '../../../../../src/agent/debug/execution/agent_surface';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';
import {createRecoveryBudgetStore} from '../../../../../src/agent/debug/recovery/budget';
import {recoveryBudgetKey} from '../../../../../src/agent/debug/recovery/key';

const deps = {} as RunStepsDeps;

const createViews = async (): Promise<WorldView> => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-recovery-surface',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('compact failure prompt embeds read-failure recovery guidance for a genuine read failure pause', async () => {
    const view = await createViews();
    let queryCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            let target = query entity.target "orders.main" {
              kind: "table.module_action"
              actionIntent: "approve"
            }
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-recovery-surface',
            deps,
            input: {done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    if (step.name !== 'browser.query') {throw new Error(`unexpected step: ${step.name}`);}
                    queryCalls += 1;
                    return {
                        stepId: step.id,
                        ok: false,
                        error: {code: 'ERR_NOT_FOUND', message: 'no service row matches', details: {matches: 0}},
                    };
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'continue', breakOnFailure: true},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'failure');
    if (pause.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(pause.failure.kind, 'step');
    assert.equal(pause.failure.classification, 'read');
    assert.equal(pause.rollbackAnchor, undefined);
    assert.equal(queryCalls, 1);

    const prompt = compactDebuggerSystemPromptForPause(pause);
    assert.match(prompt, /RECOVERY POLICY/);
    assert.match(prompt, /class=read, executed-effect-none/);
    assert.match(prompt, /Rewind to the statement savepoint from debug\.rewind_plan/);
    assert.match(prompt, /No pre-effect rollbackAnchor is available for this failure/);
    assert.doesNotMatch(prompt, /TERMINAL:/);
    await execution.advance(pause.continuationId, 'abort');
});

test('exhausted retry budget is surfaced as the deterministic terminal reason on a real failure pause', async () => {
    const view = await createViews();
    const execution = createDslDebugExecutionSession({
        source: `
            let target = query entity.target "orders.main" {
              kind: "table.module_action"
              actionIntent: "approve"
            }
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-recovery-surface',
            deps,
            input: {done: true},
            stepExecutionPort: {
                execute: async (step) => ({
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_NOT_FOUND', message: 'no service row matches'},
                }),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'continue', breakOnFailure: true},
    });

    const pause = await execution.waitForPause();
    if (pause.reason !== 'failure') {throw new Error('expected failure pause');}

    const store = createRecoveryBudgetStore();
    const key = recoveryBudgetKey(pause, 'retry');
    assert.equal(typeof key, 'string');
    store.record(key!, 'retry');
    store.record(key!, 'retry');

    const prompt = compactDebuggerSystemPromptForPause(pause, {budget: store, budgetKey: key});
    assert.match(prompt, /TERMINAL: TERMINAL_RECOVERY_BUDGET_EXHAUSTED/);
    assert.match(prompt, /Call debug.continue to terminalize/);
    assert.match(prompt, /never resubmit a second program/);
    await execution.advance(pause.continuationId, 'abort');
});

test('invariant failure prompt routes to repair-first guidance through the real ensure failure path', async () => {
    const view = await createViews();
    const execution = createDslDebugExecutionSession({
        source: `
            ensure compute eq(input.actual, input.expected)
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-recovery-surface',
            deps,
            input: {actual: 1, expected: 2, done: true},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'continue', breakOnFailure: true},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'failure');
    if (pause.reason !== 'failure') {throw new Error('expected failure pause');}
    assert.equal(pause.failure.kind, 'invariant');
    assert.equal(pause.failure.code, 'ERR_DSL_ENSURE_FAILED');

    const prompt = debuggerSystemPromptForPause(pause);
    assert.match(prompt, /RECOVERY POLICY/);
    assert.match(prompt, /class=invariant, executed-effect-none/);
    assert.match(prompt, /Preferred: patch the failed point with debug\.patch_program/);
    await execution.advance(pause.continuationId, 'abort');
});

test('barrier prompt embeds recovery guidance naming cross_barrier as the single advance', async () => {
    const view = await createViews();
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: 'click input.target\noutput done = input.done',
        context: {
            workspaceName: 'ws-recovery-surface',
            deps,
            input: {target: {nodeId: 'submit'}, done: true},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'continue', barrierOn: ['unknown']},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'barrier');
    if (pause.reason !== 'barrier') {throw new Error('expected barrier pause');}
    assert.equal(pause.effect.stepName, 'browser.click');

    const prompt = compactDebuggerSystemPromptForPause(pause);
    assert.match(prompt, /RECOVERY POLICY/);
    assert.match(prompt, /Barrier recovery policy at main@body\.0/);
    assert.match(prompt, /Authorize exactly one effect/);
    assert.match(prompt, /Authorize this effect only if it matches the user task/);
    assert.equal(clickCalls, 0);
    await execution.advance(pause.continuationId, 'abort');
});