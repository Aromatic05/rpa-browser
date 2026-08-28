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

test('automatic hidden execution points enable rewind without a manual savepoint', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let value = compute first(input.old)
            output result = vars.value
        `,
        context: {
            workspaceName: 'ws-rewind-auto',
            deps,
            input: {old: [2], next: [9]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const body0 = await execution.waitForPause();
    assert.deepEqual(execution.transaction(body0.continuationId).savepoints, []);
    const body1Result = await execution.advance(body0.continuationId, 'step');
    assert.equal(body1Result.status, 'paused');
    if (body1Result.status !== 'paused') {throw new Error('expected body.1');}
    const body1 = body1Result.pause;
    assert.deepEqual(execution.transaction(body1.continuationId).savepoints, []);

    const repair = execution.patchStatement(
        body1.continuationId,
        'let value = compute first(input.next)',
        {programId: 'main', path: 'body.0'},
    );
    assert.equal(repair.status, 'rewind_required');
    if (repair.status !== 'rewind_required') {throw new Error('expected rewind_required');}
    assert.equal(repair.rewind.status, 'ready');
    if (repair.rewind.status !== 'ready') {throw new Error('expected automatic rewind candidate');}
    assert.equal(repair.rewind.candidates[0].origin, 'automatic');
    assert.equal(repair.rewind.candidates[0].exact, true);

    const rewound = await execution.rewind(body1.continuationId, repair.rewind.candidates[0].savepointId);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected automatic rewind');}
    assert.equal(rewound.pause.location.path, 'body.0');
    assert.deepEqual(execution.transaction(rewound.pause.continuationId).savepoints, []);

    const patched = execution.patchStatement(
        rewound.pause.continuationId,
        'let value = compute first(input.next)',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected patched statement');}
    const outputPause = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(outputPause.status, 'paused');
    if (outputPause.status !== 'paused') {throw new Error('expected output pause');}
    assert.deepEqual(outputPause.pause.scope.vars, {value: 9});
    const completed = await execution.advance(outputPause.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {result: 9});}
});

test('rewind restores an if-branch execution frame and continues through the parent program', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let base = compute first(input.base)
            if input.enabled:
              let value = compute first(input.old)
              output branch = vars.value
            output result = output.branch
        `,
        context: {
            workspaceName: 'ws-rewind-if',
            deps,
            input: {base: [1], enabled: true, old: [2], next: [9]},
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
    if (body1Result.status !== 'paused') {throw new Error('expected body.1');}
    const nested0Result = await execution.advance(body1Result.pause.continuationId, 'step');
    assert.equal(nested0Result.status, 'paused');
    if (nested0Result.status !== 'paused') {throw new Error('expected nested body.0');}
    assert.equal(nested0Result.pause.location.path, 'body.1.then.0');
    assert.deepEqual(nested0Result.pause.scope.vars, {base: 1});

    const nested1Result = await execution.advance(nested0Result.pause.continuationId, 'step');
    assert.equal(nested1Result.status, 'paused');
    if (nested1Result.status !== 'paused') {throw new Error('expected nested body.1');}
    const body2Result = await execution.advance(nested1Result.pause.continuationId, 'step');
    assert.equal(body2Result.status, 'paused');
    if (body2Result.status !== 'paused') {throw new Error('expected parent body.2');}
    assert.equal(body2Result.pause.location.path, 'body.2');
    assert.deepEqual(body2Result.pause.scope.output, {branch: 2});

    const repair = execution.patchStatement(body2Result.pause.continuationId, 'let value = compute first(input.next)', {
        programId: 'main',
        path: 'body.1.then.0',
    });
    assert.equal(repair.status, 'rewind_required');
    if (repair.status !== 'rewind_required') {throw new Error('expected rewind_required');}
    assert.equal(repair.rewind.status, 'ready');
    if (repair.rewind.status !== 'ready') {throw new Error('expected branch rewind plan');}
    assert.equal(repair.rewind.candidates[0].exact, true);
    assert.equal(repair.rewind.candidates[0].location.path, 'body.1.then.0');

    const rewound = await execution.rewind(
        body2Result.pause.continuationId,
        repair.rewind.candidates[0].savepointId,
    );
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected branch rewind');}
    assert.equal(rewound.pause.location.path, 'body.1.then.0');
    assert.deepEqual(rewound.pause.scope.vars, {base: 1});

    const patched = execution.patchStatement(rewound.pause.continuationId, 'let value = compute first(input.next)');
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected patched branch statement');}
    const nestedOutput = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(nestedOutput.status, 'paused');
    if (nestedOutput.status !== 'paused') {throw new Error('expected nested output');}
    assert.equal(nestedOutput.pause.location.path, 'body.1.then.1');
    assert.deepEqual(nestedOutput.pause.scope.vars, {base: 1, value: 9});
    const parentOutput = await execution.advance(nestedOutput.pause.continuationId, 'step');
    assert.equal(parentOutput.status, 'paused');
    if (parentOutput.status !== 'paused') {throw new Error('expected parent output');}
    assert.equal(parentOutput.pause.location.path, 'body.2');
    assert.deepEqual(parentOutput.pause.scope.vars, {base: 1});
    assert.deepEqual(parentOutput.pause.scope.output, {branch: 9});
    const completed = await execution.advance(parentOutput.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {branch: 9, result: 9});}
});

test('rewind restores multiple nested if frames before returning to the root body', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            if input.outer:
              if input.inner:
                output inner = input.value
              output outer = output.inner
            output result = output.outer
        `,
        context: {
            workspaceName: 'ws-rewind-nested-if',
            deps,
            input: {outer: true, inner: true, value: 7},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outer = await execution.waitForPause();
    const innerIf = await execution.advance(outer.continuationId, 'step');
    assert.equal(innerIf.status, 'paused');
    if (innerIf.status !== 'paused') {throw new Error('expected inner if');}
    const innerOutput = await execution.advance(innerIf.pause.continuationId, 'step');
    assert.equal(innerOutput.status, 'paused');
    if (innerOutput.status !== 'paused') {throw new Error('expected inner output');}
    assert.equal(innerOutput.pause.location.path, 'body.0.then.0.then.0');

    const outerOutput = await execution.advance(innerOutput.pause.continuationId, 'step');
    assert.equal(outerOutput.status, 'paused');
    if (outerOutput.status !== 'paused') {throw new Error('expected outer output');}
    const rootOutput = await execution.advance(outerOutput.pause.continuationId, 'step');
    assert.equal(rootOutput.status, 'paused');
    if (rootOutput.status !== 'paused') {throw new Error('expected root output');}
    assert.equal(rootOutput.pause.location.path, 'body.1');

    const plan = execution.rewindPlan(rootOutput.pause.continuationId, {
        programId: 'main',
        path: 'body.0.then.0.then.0',
    });
    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') {throw new Error('expected nested if rewind plan');}
    const rewound = await execution.rewind(rootOutput.pause.continuationId, plan.candidates[0].savepointId);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected nested if rewind');}
    assert.equal(rewound.pause.location.path, 'body.0.then.0.then.0');

    const afterInner = await execution.advance(rewound.pause.continuationId, 'step');
    assert.equal(afterInner.status, 'paused');
    if (afterInner.status !== 'paused') {throw new Error('expected outer branch after inner rewind');}
    assert.equal(afterInner.pause.location.path, 'body.0.then.1');
    assert.deepEqual(afterInner.pause.scope.output, {inner: 7});
    const afterOuter = await execution.advance(afterInner.pause.continuationId, 'step');
    assert.equal(afterOuter.status, 'paused');
    if (afterOuter.status !== 'paused') {throw new Error('expected root after outer branch');}
    assert.equal(afterOuter.pause.location.path, 'body.1');
    assert.deepEqual(afterOuter.pause.scope.output, {inner: 7, outer: 7});
    const completed = await execution.advance(afterOuter.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
        assert.deepEqual(completed.output, {inner: 7, outer: 7, result: 7});
    }
});

test('rewind plan distinguishes loop iterations and rewind resumes the remaining iterations', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            for item in input.items:
              output current = item
            output result = output.current
        `,
        context: {
            workspaceName: 'ws-rewind-loop',
            deps,
            input: {items: [1, 2], replacement: 9},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outer = await execution.waitForPause();
    const iteration0 = await execution.advance(outer.continuationId, 'step');
    assert.equal(iteration0.status, 'paused');
    if (iteration0.status !== 'paused') {throw new Error('expected iteration 0');}
    assert.deepEqual(iteration0.pause.location.loops, [{path: 'body.0', iteration: 0}]);
    const iteration1 = await execution.advance(iteration0.pause.continuationId, 'step');
    assert.equal(iteration1.status, 'paused');
    if (iteration1.status !== 'paused') {throw new Error('expected iteration 1');}
    assert.deepEqual(iteration1.pause.location.loops, [{path: 'body.0', iteration: 1}]);
    const root = await execution.advance(iteration1.pause.continuationId, 'step');
    assert.equal(root.status, 'paused');
    if (root.status !== 'paused') {throw new Error('expected root output');}

    const plan = execution.rewindPlan(root.pause.continuationId, {
        programId: 'main',
        path: 'body.0.body.0',
    });
    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') {throw new Error('expected loop rewind plan');}
    assert.deepEqual(
        plan.candidates.map((candidate) => candidate.location.loops[0]?.iteration),
        [1, 0],
    );

    const rewound = await execution.rewind(root.pause.continuationId, plan.candidates[1].savepointId);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected iteration 0 rewind');}
    assert.deepEqual(rewound.pause.location.loops, [{path: 'body.0', iteration: 0}]);
    assert.equal(rewound.pause.scope.vars.item, 1);

    const resumedIteration1 = await execution.advance(rewound.pause.continuationId, 'step');
    assert.equal(resumedIteration1.status, 'paused');
    if (resumedIteration1.status !== 'paused') {throw new Error('expected resumed iteration 1');}
    assert.deepEqual(resumedIteration1.pause.location.loops, [{path: 'body.0', iteration: 1}]);
    assert.deepEqual(resumedIteration1.pause.scope.output, {current: 1});
    assert.equal(resumedIteration1.pause.scope.vars.item, 2);

    const patched = execution.patchStatement(
        resumedIteration1.pause.continuationId,
        'output current = input.replacement',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected loop patch');}
    const rootAgain = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(rootAgain.status, 'paused');
    if (rootAgain.status !== 'paused') {throw new Error('expected root after loop');}
    assert.equal(rootAgain.pause.location.path, 'body.1');
    assert.deepEqual(rootAgain.pause.scope.output, {current: 9});
    const completed = await execution.advance(rootAgain.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
        assert.deepEqual(completed.output, {current: 9, result: 9});
    }
});

test('rewind unwinds a loop frame inside an if frame in execution order', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            if input.enabled:
              for item in input.items:
                output current = item
              output branch = output.current
            output result = output.branch
        `,
        context: {
            workspaceName: 'ws-rewind-if-loop',
            deps,
            input: {enabled: true, items: [1, 2]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outerIf = await execution.waitForPause();
    const loopStatement = await execution.advance(outerIf.continuationId, 'step');
    assert.equal(loopStatement.status, 'paused');
    if (loopStatement.status !== 'paused') {throw new Error('expected loop statement');}
    const iteration0 = await execution.advance(loopStatement.pause.continuationId, 'step');
    assert.equal(iteration0.status, 'paused');
    if (iteration0.status !== 'paused') {throw new Error('expected iteration 0');}
    const iteration1 = await execution.advance(iteration0.pause.continuationId, 'step');
    assert.equal(iteration1.status, 'paused');
    if (iteration1.status !== 'paused') {throw new Error('expected iteration 1');}
    assert.equal(iteration1.pause.location.path, 'body.0.then.0.body.0');
    assert.deepEqual(iteration1.pause.location.loops, [{path: 'body.0.then.0', iteration: 1}]);
    const branchOutput = await execution.advance(iteration1.pause.continuationId, 'step');
    assert.equal(branchOutput.status, 'paused');
    if (branchOutput.status !== 'paused') {throw new Error('expected branch output');}
    const rootOutput = await execution.advance(branchOutput.pause.continuationId, 'step');
    assert.equal(rootOutput.status, 'paused');
    if (rootOutput.status !== 'paused') {throw new Error('expected root output');}

    const plan = execution.rewindPlan(rootOutput.pause.continuationId, {
        programId: 'main',
        path: 'body.0.then.0.body.0',
    });
    assert.equal(plan.status, 'ready');
    if (plan.status !== 'ready') {throw new Error('expected mixed-frame rewind plan');}
    const rewound = await execution.rewind(rootOutput.pause.continuationId, plan.candidates[0].savepointId);
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected mixed-frame rewind');}
    assert.equal(rewound.pause.location.path, 'body.0.then.0.body.0');
    assert.deepEqual(rewound.pause.location.loops, [{path: 'body.0.then.0', iteration: 1}]);

    const afterLoop = await execution.advance(rewound.pause.continuationId, 'step');
    assert.equal(afterLoop.status, 'paused');
    if (afterLoop.status !== 'paused') {throw new Error('expected branch continuation');}
    assert.equal(afterLoop.pause.location.path, 'body.0.then.1');
    assert.deepEqual(afterLoop.pause.scope.output, {current: 2});
    const afterIf = await execution.advance(afterLoop.pause.continuationId, 'step');
    assert.equal(afterIf.status, 'paused');
    if (afterIf.status !== 'paused') {throw new Error('expected root continuation');}
    assert.equal(afterIf.pause.location.path, 'body.1');
    assert.deepEqual(afterIf.pause.scope.output, {current: 2, branch: 2});
    const completed = await execution.advance(afterIf.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {
        assert.deepEqual(completed.output, {current: 2, branch: 2, result: 2});
    }
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

test('rewind accepts explicit loop statement savepoints and restores the saved iteration', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            for item in input.items:
              output result = item
        `,
        context: {
            workspaceName: 'ws-rewind-loop-savepoint',
            deps,
            input: {items: [1, 2]},
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
    assert.equal(nested.location.path, 'body.0.body.0');
    assert.deepEqual(nested.location.loops, [{path: 'body.0', iteration: 0}]);
    const savepoint = execution.savepoint(nested.continuationId, 'nested');
    const result = await execution.rewind(nested.continuationId, savepoint.id);
    assert.equal(result.status, 'rewound');
    if (result.status !== 'rewound') {throw new Error('expected loop rewind');}
    assert.equal(result.pause.location.path, 'body.0.body.0');
    assert.deepEqual(result.pause.location.loops, [{path: 'body.0', iteration: 0}]);
    assert.equal(result.pause.scope.vars.item, 1);
    await execution.advance(result.pause.continuationId, 'abort');
});

test('rewind restarts a checkpoint child and rebinds its new output into the caller scope', async () => {
    const view = await createView();
    const checkpoint = {
        id: 'child',
        kind: 'procedure' as const,
        body: {language: 'dsl' as const, source: 'body.dsl' as const},
    };
    const childSource = `
        let picked = compute first(input.value)
        output value = vars.picked
    `;
    const execution = createDslDebugExecutionSession({
        source: `
            let session = use checkpoint "child" with {
              value: input.old
              replacement: input.next
            }
            output result = session.value
        `,
        context: {
            workspaceName: 'ws-rewind-checkpoint',
            deps,
            input: {old: [2], next: [9]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
            checkpointProvider: {
                getCheckpoint: (id) => id === 'child' ? checkpoint : null,
                getCheckpointResolves: () => ({}),
                getCheckpointBody: (id) => id === 'child'
                    ? {source: childSource, stepResolves: {}}
                    : null,
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const caller = await execution.waitForPause();
    assert.equal(caller.location.programId, 'main');
    assert.equal(caller.location.path, 'body.0');
    const childLet = await execution.advance(caller.continuationId, 'step');
    assert.equal(childLet.status, 'paused');
    if (childLet.status !== 'paused') {throw new Error('expected child let');}
    assert.equal(childLet.pause.location.programId, 'checkpoint:child');
    assert.equal(childLet.pause.location.path, 'body.0');
    const childPlan = execution.rewindPlan(childLet.pause.continuationId, {
        programId: 'checkpoint:child',
        path: 'body.0',
    });
    assert.equal(childPlan.status, 'ready');
    if (childPlan.status !== 'ready') {throw new Error('expected child rewind plan');}
    const childSavepoint = execution.executionSavepoint(
        childLet.pause.continuationId,
        childPlan.candidates[0].savepointId,
    );
    const checkpointFrame = childSavepoint?.frames.at(-1);
    assert.equal(checkpointFrame?.kind, 'checkpoint');
    if (checkpointFrame?.kind === 'checkpoint') {
        assert.equal(checkpointFrame.parentProgramId, 'main');
        assert.equal(checkpointFrame.bind, 'session');
    }

    const childOutput = await execution.advance(childLet.pause.continuationId, 'step');
    assert.equal(childOutput.status, 'paused');
    if (childOutput.status !== 'paused') {throw new Error('expected child output');}
    const mainOutput = await execution.advance(childOutput.pause.continuationId, 'step');
    assert.equal(mainOutput.status, 'paused');
    if (mainOutput.status !== 'paused') {throw new Error('expected main output');}
    assert.equal(mainOutput.pause.location.programId, 'main');
    assert.equal(mainOutput.pause.location.path, 'body.1');
    assert.deepEqual(mainOutput.pause.scope.vars.session, {value: 2});

    const repair = execution.patchStatement(
        mainOutput.pause.continuationId,
        'let picked = compute first(input.replacement)',
        {programId: 'checkpoint:child', path: 'body.0'},
    );
    assert.equal(repair.status, 'rewind_required');
    if (repair.status !== 'rewind_required') {throw new Error('expected checkpoint rewind repair');}
    assert.equal(repair.rewind.status, 'ready');
    if (repair.rewind.status !== 'ready') {throw new Error('expected checkpoint rewind plan');}
    assert.equal(repair.rewind.candidates[0].location.programId, 'checkpoint:child');

    const rewound = await execution.rewind(
        mainOutput.pause.continuationId,
        repair.rewind.candidates[0].savepointId,
    );
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected checkpoint rewind');}
    assert.equal(rewound.pause.location.programId, 'checkpoint:child');
    assert.equal(rewound.pause.location.path, 'body.0');
    assert.deepEqual(rewound.pause.scope.input, {value: [2], replacement: [9]});

    const patched = execution.patchStatement(
        rewound.pause.continuationId,
        'let picked = compute first(input.replacement)',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected checkpoint child patch');}
    const newChildOutput = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(newChildOutput.status, 'paused');
    if (newChildOutput.status !== 'paused') {throw new Error('expected new child output');}
    const reboundCaller = await execution.advance(newChildOutput.pause.continuationId, 'step');
    assert.equal(reboundCaller.status, 'paused');
    if (reboundCaller.status !== 'paused') {throw new Error('expected rebound caller');}
    assert.equal(reboundCaller.pause.location.programId, 'main');
    assert.equal(reboundCaller.pause.location.path, 'body.1');
    assert.deepEqual(reboundCaller.pause.scope.vars.session, {value: 9});
    assert.equal(execution.explain(reboundCaller.pause.continuationId, 'vars.session').origin, 'derived');

    const completed = await execution.advance(reboundCaller.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {result: 9});}
});

test('rewind unwinds nested checkpoint programs back through both callers', async () => {
    const view = await createView();
    const checkpoints = {
        outer: {id: 'outer', kind: 'procedure' as const, body: {language: 'dsl' as const, source: 'body.dsl' as const}},
        inner: {id: 'inner', kind: 'procedure' as const, body: {language: 'dsl' as const, source: 'body.dsl' as const}},
    };
    const bodies: Record<string, string> = {
        outer: `
            let inner = use checkpoint "inner" with {
              old: input.old
              next: input.next
            }
            output value = inner.value
        `,
        inner: `
            let picked = compute first(input.old)
            output value = vars.picked
        `,
    };
    const execution = createDslDebugExecutionSession({
        source: `
            let outer = use checkpoint "outer" with {
              old: input.old
              next: input.next
            }
            output result = outer.value
        `,
        context: {
            workspaceName: 'ws-rewind-nested-checkpoint',
            deps,
            input: {old: [3], next: [11]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
            checkpointProvider: {
                getCheckpoint: (id) => checkpoints[id as keyof typeof checkpoints] ?? null,
                getCheckpointResolves: () => ({}),
                getCheckpointBody: (id) => bodies[id]
                    ? {source: bodies[id], stepResolves: {}}
                    : null,
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const mainCheckpoint = await execution.waitForPause();
    const outerCheckpoint = await execution.advance(mainCheckpoint.continuationId, 'step');
    assert.equal(outerCheckpoint.status, 'paused');
    if (outerCheckpoint.status !== 'paused') {throw new Error('expected outer checkpoint statement');}
    assert.equal(outerCheckpoint.pause.location.programId, 'checkpoint:outer');
    const innerLet = await execution.advance(outerCheckpoint.pause.continuationId, 'step');
    assert.equal(innerLet.status, 'paused');
    if (innerLet.status !== 'paused') {throw new Error('expected inner let');}
    assert.equal(innerLet.pause.location.programId, 'checkpoint:inner');
    assert.deepEqual(innerLet.pause.location.callStack, ['outer', 'inner']);
    const innerOutput = await execution.advance(innerLet.pause.continuationId, 'step');
    assert.equal(innerOutput.status, 'paused');
    if (innerOutput.status !== 'paused') {throw new Error('expected inner output');}
    const outerOutput = await execution.advance(innerOutput.pause.continuationId, 'step');
    assert.equal(outerOutput.status, 'paused');
    if (outerOutput.status !== 'paused') {throw new Error('expected outer output');}
    const mainOutput = await execution.advance(outerOutput.pause.continuationId, 'step');
    assert.equal(mainOutput.status, 'paused');
    if (mainOutput.status !== 'paused') {throw new Error('expected main output');}
    assert.deepEqual(mainOutput.pause.scope.vars.outer, {value: 3});

    const repair = execution.patchStatement(
        mainOutput.pause.continuationId,
        'let picked = compute first(input.next)',
        {programId: 'checkpoint:inner', path: 'body.0'},
    );
    assert.equal(repair.status, 'rewind_required');
    if (repair.status !== 'rewind_required') {throw new Error('expected nested checkpoint rewind repair');}
    assert.equal(repair.rewind.status, 'ready');
    if (repair.rewind.status !== 'ready') {throw new Error('expected nested checkpoint rewind plan');}

    const rewound = await execution.rewind(
        mainOutput.pause.continuationId,
        repair.rewind.candidates[0].savepointId,
    );
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected nested checkpoint rewind');}
    assert.equal(rewound.pause.location.programId, 'checkpoint:inner');
    assert.deepEqual(rewound.pause.location.callStack, ['outer', 'inner']);
    const patched = execution.patchStatement(
        rewound.pause.continuationId,
        'let picked = compute first(input.next)',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected inner patch');}
    const innerOutputAgain = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(innerOutputAgain.status, 'paused');
    if (innerOutputAgain.status !== 'paused') {throw new Error('expected inner output again');}
    const outerOutputAgain = await execution.advance(innerOutputAgain.pause.continuationId, 'step');
    assert.equal(outerOutputAgain.status, 'paused');
    if (outerOutputAgain.status !== 'paused') {throw new Error('expected outer output again');}
    assert.deepEqual(outerOutputAgain.pause.scope.vars.inner, {value: 11});
    const mainOutputAgain = await execution.advance(outerOutputAgain.pause.continuationId, 'step');
    assert.equal(mainOutputAgain.status, 'paused');
    if (mainOutputAgain.status !== 'paused') {throw new Error('expected main output again');}
    assert.deepEqual(mainOutputAgain.pause.scope.vars.outer, {value: 11});
    const completed = await execution.advance(mainOutputAgain.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {result: 11});}
});

test('checkpoint rewind resumes the caller inside an if frame before returning to root', async () => {
    const view = await createView();
    const checkpoint = {
        id: 'child',
        kind: 'procedure' as const,
        body: {language: 'dsl' as const, source: 'body.dsl' as const},
    };
    const childSource = `
        let picked = compute first(input.old)
        output value = vars.picked
    `;
    const execution = createDslDebugExecutionSession({
        source: `
            if input.enabled:
              let session = use checkpoint "child" with {
                old: input.old
                next: input.next
              }
              output branch = session.value
            output result = output.branch
        `,
        context: {
            workspaceName: 'ws-rewind-checkpoint-if',
            deps,
            input: {enabled: true, old: [4], next: [12]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
            checkpointProvider: {
                getCheckpoint: (id) => id === 'child' ? checkpoint : null,
                getCheckpointResolves: () => ({}),
                getCheckpointBody: (id) => id === 'child'
                    ? {source: childSource, stepResolves: {}}
                    : null,
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const outerIf = await execution.waitForPause();
    const checkpointCall = await execution.advance(outerIf.continuationId, 'step');
    assert.equal(checkpointCall.status, 'paused');
    if (checkpointCall.status !== 'paused') {throw new Error('expected checkpoint call');}
    assert.equal(checkpointCall.pause.location.path, 'body.0.then.0');
    const childLet = await execution.advance(checkpointCall.pause.continuationId, 'step');
    assert.equal(childLet.status, 'paused');
    if (childLet.status !== 'paused') {throw new Error('expected child let');}
    const childOutput = await execution.advance(childLet.pause.continuationId, 'step');
    assert.equal(childOutput.status, 'paused');
    if (childOutput.status !== 'paused') {throw new Error('expected child output');}
    const branchOutput = await execution.advance(childOutput.pause.continuationId, 'step');
    assert.equal(branchOutput.status, 'paused');
    if (branchOutput.status !== 'paused') {throw new Error('expected branch output');}
    const rootOutput = await execution.advance(branchOutput.pause.continuationId, 'step');
    assert.equal(rootOutput.status, 'paused');
    if (rootOutput.status !== 'paused') {throw new Error('expected root output');}
    assert.deepEqual(rootOutput.pause.scope.output, {branch: 4});

    const repair = execution.patchStatement(
        rootOutput.pause.continuationId,
        'let picked = compute first(input.next)',
        {programId: 'checkpoint:child', path: 'body.0'},
    );
    assert.equal(repair.status, 'rewind_required');
    if (repair.status !== 'rewind_required' || repair.rewind.status !== 'ready') {
        throw new Error('expected checkpoint rewind plan');
    }
    const rewound = await execution.rewind(
        rootOutput.pause.continuationId,
        repair.rewind.candidates[0].savepointId,
    );
    assert.equal(rewound.status, 'rewound');
    if (rewound.status !== 'rewound') {throw new Error('expected checkpoint rewind');}
    const patched = execution.patchStatement(
        rewound.pause.continuationId,
        'let picked = compute first(input.next)',
    );
    assert.equal(patched.status, 'patched');
    if (patched.status !== 'patched') {throw new Error('expected checkpoint patch');}
    const childOutputAgain = await execution.advance(patched.pause.continuationId, 'step');
    assert.equal(childOutputAgain.status, 'paused');
    if (childOutputAgain.status !== 'paused') {throw new Error('expected child output again');}
    const branchOutputAgain = await execution.advance(childOutputAgain.pause.continuationId, 'step');
    assert.equal(branchOutputAgain.status, 'paused');
    if (branchOutputAgain.status !== 'paused') {throw new Error('expected branch output again');}
    assert.equal(branchOutputAgain.pause.location.path, 'body.0.then.1');
    assert.deepEqual(branchOutputAgain.pause.scope.vars.session, {value: 12});
    const rootOutputAgain = await execution.advance(branchOutputAgain.pause.continuationId, 'step');
    assert.equal(rootOutputAgain.status, 'paused');
    if (rootOutputAgain.status !== 'paused') {throw new Error('expected root output again');}
    assert.equal(rootOutputAgain.pause.location.path, 'body.1');
    assert.deepEqual(rootOutputAgain.pause.scope.output, {branch: 12});
    const completed = await execution.advance(rootOutputAgain.pause.continuationId, 'continue');
    assert.equal(completed.status, 'completed');
    if (completed.status === 'completed') {assert.deepEqual(completed.output, {branch: 12, result: 12});}
});
