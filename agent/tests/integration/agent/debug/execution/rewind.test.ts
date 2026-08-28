import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const deps = {} as RunStepsDeps;

const createView = async (): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-rewind',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('rewind restarts a pure top-level statement from saved scope and truncates the abandoned future', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let first = compute first(input.first)
            let value = compute first(input.old)
            output result = vars.value
        `,
        context: {
            workspaceName: 'ws-rewind',
            deps,
            input: {first: [1], old: [2], next: [3]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const body0 = await execution.waitForPause();
    const body1Result = await execution.advance(body0.continuationId, 'step');
    assert.equal(body1Result.status, 'paused');
    if (body1Result.status !== 'paused') {throw new Error('expected body.1 pause');}
    const body1 = body1Result.pause;
    assert.equal(body1.location.path, 'body.1');
    assert.deepEqual(body1.scope.vars, {first: 1});
    const savepoint = execution.savepoint(body1.continuationId, 'before-value');

    const body2Result = await execution.advance(body1.continuationId, 'step');
    assert.equal(body2Result.status, 'paused');
    if (body2Result.status !== 'paused') {throw new Error('expected body.2 pause');}
    const body2 = body2Result.pause;
    assert.equal(body2.location.path, 'body.2');
    assert.deepEqual(body2.scope.vars, {first: 1, value: 2});
    const abandonedSavepoint = execution.savepoint(body2.continuationId, 'abandoned-future');
    assert.equal(execution.history(body2.continuationId).records.length, 2);
    assert.equal(execution.explain(body2.continuationId, 'vars.value').origin, 'derived');

    const rewound = await execution.rewind(body2.continuationId, savepoint.id);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected rewind');}
    assert.notEqual(rewound.pause.continuationId, body2.continuationId);
    assert.equal(rewound.pause.location.path, 'body.1');
    assert.deepEqual(rewound.pause.scope.vars, {first: 1});
    assert.equal(execution.history(rewound.pause.continuationId).records.length, 1);
    assert.equal(execution.explain(rewound.pause.continuationId, 'vars.value').origin, 'untracked');
    assert.deepEqual(
        execution.transaction(rewound.pause.continuationId).savepoints.map((item) => item.id),
        [savepoint.id],
    );
    assert.equal(execution.executionSavepoint(rewound.pause.continuationId, abandonedSavepoint.id), null);

    const patched = execution.patchStatement(
        rewound.pause.continuationId,
        'let value = compute first(input.next)',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected patched statement');}
    const body2Again = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(body2Again.status, 'paused');
    if (body2Again.status !== 'paused') {throw new Error('expected body.2 after rewind');}
    assert.deepEqual(body2Again.pause.scope.vars, {first: 1, value: 3});

    const completed = await execution.advance(body2Again.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {result: 3});}
});

test('rewind stays on the current continuation when World effects after the savepoint are not restored', async () => {
    const view = await createView();
    let clickCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output result = input.result
        `,
        context: {
            workspaceName: 'ws-rewind-effect',
            deps,
            input: {target: {nodeId: 'submit'}, result: 'ok'},
            stepExecutionPort: {
                execute: async (step) => {
                    clickCalls += 1;
                    return {stepId: step.id, ok: true, data: {clicked: true}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step', breakBeforeEffects: true, breakpoints: ['body.1']},
    });

    const statement = await execution.waitForPause();
    assert.equal(statement.reason, 'statement');
    const savepoint = execution.savepoint(statement.continuationId, 'before-click');
    const effectResult = await execution.advance(statement.continuationId, 'step');
    assert.equal(effectResult.status, 'paused');
    if (effectResult.status !== 'paused') {throw new Error('expected effect pause');}
    assert.equal(effectResult.pause.reason, 'effect');

    const afterClickResult = await execution.advance(effectResult.pause.continuationId, 'continue');
    assert.equal(afterClickResult.status, 'paused');
    if (afterClickResult.status !== 'paused') {throw new Error('expected body.1 pause');}
    assert.equal(clickCalls, 1);

    const blocked = await execution.rewind(afterClickResult.pause.continuationId, savepoint.id);
    assert.equal(blocked.status, 'blocked');
    if (blocked.status === 'blocked') {
        assert.equal(blocked.reason, 'world_not_restored');
        assert.equal(blocked.rollback.status, 'blocked');
        if (blocked.rollback.status === 'blocked') {
            assert.equal(blocked.rollback.reason, 'effects_require_compensation');
        }
    }
    assert.equal(execution.history(afterClickResult.pause.continuationId).records.length, 1);
    await execution.advance(afterClickResult.pause.continuationId, 'abort');
});

test('debug.rewind updates the Agent tool session to the new continuation and remains a control operation', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let first = compute first(input.first)
            let value = compute first(input.old)
            output result = vars.value
        `,
        context: {
            workspaceName: 'ws-rewind-tool',
            deps,
            input: {first: [1], old: [2]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const body0 = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, body0);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;
    const body1Result = await tool('debug.step').execute('step-0', {});
    assert.equal((body1Result.details as any).pause.location.path, 'body.1');
    const saved = await tool('debug.savepoint').execute('savepoint', {name: 'before-value'});
    const savepointId = (saved.details as any).savepoint.id as string;

    const body2Result = await tool('debug.step').execute('step-1', {});
    const oldContinuationId = (body2Result.details as any).pause.continuationId as string;
    assert.equal((body2Result.details as any).pause.location.path, 'body.2');

    const rewound = await tool('debug.rewind').execute('rewind', {savepointId});
    assert.equal((rewound.details as any).status, 'rewound');
    assert.equal((rewound.details as any).pause.location.path, 'body.1');
    assert.notEqual((rewound.details as any).pause.continuationId, oldContinuationId);
    assert.equal(tools.readPause()?.continuationId, (rewound.details as any).pause.continuationId);
    assert.equal(tools.readPause()?.location.path, 'body.1');
    assert.equal(classifyPausedDslDebugToolCall('debug.rewind'), 'control');

    await tool('debug.abort').execute('abort', {});
});

test('rewind plan lists exact and prior savepoints nearest-first without mutating execution', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let first = compute first(input.first)
            let value = compute first(input.old)
            output result = vars.value
        `,
        context: {
            workspaceName: 'ws-rewind-plan',
            deps,
            input: {first: [1], old: [2]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const body0 = await execution.waitForPause();
    const prior = execution.savepoint(body0.continuationId, 'prior');
    const body1Result = await execution.advance(body0.continuationId, 'step');
    assert.equal(body1Result.status, 'paused');
    if (body1Result.status !== 'paused') {throw new Error('expected body.1');}
    const exact = execution.savepoint(body1Result.pause.continuationId, 'exact');
    const body2Result = await execution.advance(body1Result.pause.continuationId, 'step');
    assert.equal(body2Result.status, 'paused');
    if (body2Result.status !== 'paused') {throw new Error('expected body.2');}

    const plan = execution.rewindPlan(body2Result.pause.continuationId, {programId: 'main', path: 'body.1'});
    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') {throw new Error('expected rewind plan');}
    assert.deepEqual(plan.target, {programId: 'main', path: 'body.1', executions: 1});
    assert.deepEqual(plan.candidates.map((candidate) => ({
        id: candidate.savepointId,
        name: candidate.name,
        path: candidate.location.path,
        exact: candidate.exact,
        replayStatements: candidate.replayStatements,
    })), [
        {id: exact.id, name: 'exact', path: 'body.1', exact: true, replayStatements: 0},
        {id: prior.id, name: 'prior', path: 'body.0', exact: false, replayStatements: 1},
    ]);
    assert.equal(execution.history(body2Result.pause.continuationId).records.length, 2);

    const tools = createPausedDslDebugAgentTools(execution, body2Result.pause);
    const planTool = tools.tools.find((tool) => tool.name === 'debug.rewind_plan')!;
    const viaTool = await planTool.execute('rewind-plan', {programId: 'main', path: 'body.1'});
    assert.equal((viaTool.details as any).status, 'ready');
    assert.equal((viaTool.details as any).candidates[0].savepointId, exact.id);
    assert.equal(classifyPausedDslDebugToolCall('debug.rewind_plan'), 'read');

    await execution.advance(body2Result.pause.continuationId, 'abort');
});

test('rewind plan rejects nested targets until nested execution frames are restorable', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            if input.enabled:
              let value = compute first(input.values)
            output result = input.done
        `,
        context: {
            workspaceName: 'ws-rewind-plan-nested',
            deps,
            input: {enabled: true, values: [2], done: true},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outer = await execution.waitForPause();
    const nestedResult = await execution.advance(outer.continuationId, 'step');
    assert.equal(nestedResult.status, 'paused');
    if (nestedResult.status !== 'paused') {throw new Error('expected nested pause');}
    const plan = execution.rewindPlan(nestedResult.pause.continuationId, {
        programId: 'main',
        path: 'body.0.then.0',
    });
    assert.equal(plan.status, 'unsupported_target');
    if (plan.status === 'unsupported_target') {assert.equal(plan.reason, 'not_main_top_level');}
    await execution.advance(nestedResult.pause.continuationId, 'abort');
});

test('rewind rejects effect savepoints instead of treating a pending effect as a restartable statement', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-rewind-effect-savepoint',
            deps,
            input: {target: {nodeId: 'submit'}},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {clicked: true}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
    });

    const effect = await execution.waitForPause();
    assert.equal(effect.reason, 'effect');
    const savepoint = execution.savepoint(effect.continuationId, 'pending-effect');
    const result = await execution.rewind(effect.continuationId, savepoint.id);
    assert.equal(result.status, 'unsupported_target');
    if (result.status === 'unsupported_target') {
        assert.equal(result.reason, 'not_statement_savepoint');
    }
    await execution.advance(effect.continuationId, 'abort');
});

test('rewind rejects nested statement savepoints until execution frames can be reconstructed', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            if input.enabled:
              let value = compute first(input.values)
            output result = input.done
        `,
        context: {
            workspaceName: 'ws-rewind-nested',
            deps,
            input: {enabled: true, values: [2], done: true},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outer = await execution.waitForPause();
    const nestedResult = await execution.advance(outer.continuationId, 'step');
    assert.equal(nestedResult.status, 'paused');
    if (nestedResult.status !== 'paused') {throw new Error('expected nested pause');}
    const nested = nestedResult.pause;
    assert.equal(nested.location.path, 'body.0.then.0');
    const savepoint = execution.savepoint(nested.continuationId, 'nested');
    const result = await execution.rewind(nested.continuationId, savepoint.id);
    assert.equal(result.status, 'unsupported_target');
    if (result.status === 'unsupported_target') {
        assert.equal(result.reason, 'not_main_top_level');
    }
    await execution.advance(nested.continuationId, 'abort');
});
