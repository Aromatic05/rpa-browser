import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
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
        workspaceName: 'ws-program-patch',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const source = `
    let first = compute first(input.first)
    let value = compute first(input.old)
    output result = vars.value
`;

const createExecution = async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source,
        context: {
            workspaceName: 'ws-program-patch',
            deps,
            input: {first: [1], old: [2], next: [3]},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    return {execution, pause: await execution.waitForPause()};
};

test('durable program patches overlay future/current statements without modifying ProgramView', async () => {
    const {execution, pause} = await createExecution();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;

    const future = await tool('debug.patch_program').execute('patch-future', {
        programId: 'main',
        path: 'body.1',
        source: 'let value = compute first(input.next)',
    });
    assert.equal((future.details as any).status, 'patched');
    assert.equal((future.details as any).target.state, 'future');

    const listed = await tool('debug.patches').execute('patches', {programId: 'main'});
    assert.equal((listed.details as any).patches.length, 1);
    assert.equal((listed.details as any).patches[0].path, 'body.1');

    const original = await tool('debug.program').execute('program', {programId: 'main'});
    assert.deepEqual((original.details as any).program.statements[1].statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.old'}}]}},
    });

    const body1 = await tool('debug.step').execute('step-first', {});
    assert.equal((body1.details as any).pause.location.path, 'body.1');
    assert.deepEqual((body1.details as any).pause.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.next'}}]}},
    });

    const removed = await tool('debug.unpatch_program').execute('unpatch', {programId: 'main', path: 'body.1'});
    assert.equal((removed.details as any).status, 'removed');
    assert.deepEqual((removed.details as any).pause.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.old'}}]}},
    });

    const current = await tool('debug.patch_program').execute('patch-current', {
        programId: 'main',
        path: 'body.1',
        source: 'let value = compute first(input.next)',
    });
    assert.equal((current.details as any).status, 'patched');
    assert.equal((current.details as any).target.state, 'current');

    const body2 = await tool('debug.step').execute('step-value', {});
    assert.deepEqual((body2.details as any).pause.scope.vars, {first: 1, value: 3});
    const completed = await tool('debug.continue').execute('continue', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 3});
});

test('later durable patches validate against the current program overlay', async () => {
    const {execution, pause} = await createExecution();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;

    const define = await tool('debug.patch_program').execute('patch-define', {
        programId: 'main',
        path: 'body.1',
        source: 'let nextValue = compute first(input.next)',
    });
    assert.equal((define.details as any).status, 'patched');

    const consume = await tool('debug.patch_program').execute('patch-consume', {
        programId: 'main',
        path: 'body.2',
        source: 'output result = vars.nextValue',
    });
    assert.equal((consume.details as any).status, 'patched');
    assert.equal(execution.patches(pause.continuationId).length, 2);

    await tool('debug.step').execute('step-first', {});
    const outputPause = await tool('debug.step').execute('step-next-value', {});
    assert.equal((outputPause.details as any).pause.location.path, 'body.2');
    assert.deepEqual((outputPause.details as any).pause.scope.vars, {first: 1, nextValue: 3});

    const completed = await tool('debug.continue').execute('continue', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 3});
});

test('patching an executed path installs the overlay before rewind and reapplies it on the new continuation', async () => {
    const {execution, pause} = await createExecution();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;

    await tool('debug.step').execute('step-first', {});
    const body2 = await tool('debug.step').execute('step-old-value', {});
    assert.equal((body2.details as any).pause.location.path, 'body.2');
    assert.equal((body2.details as any).pause.scope.vars.value, 2);

    const patched = await tool('debug.patch_program').execute('patch-executed', {
        programId: 'main',
        path: 'body.1',
        source: 'let value = compute first(input.next)',
    });
    assert.equal((patched.details as any).status, 'rewind_required');
    assert.equal((patched.details as any).target.executions, 1);
    assert.equal((patched.details as any).rewind.status, 'ready');
    const candidate = (patched.details as any).rewind.candidates[0];
    assert.equal(candidate.location.path, 'body.1');

    const rewound = await tool('debug.rewind').execute('rewind', {savepointId: candidate.savepointId});
    assert.equal((rewound.details as any).status, 'rewound');
    assert.equal((rewound.details as any).pause.location.path, 'body.1');
    assert.deepEqual((rewound.details as any).pause.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.next'}}]}},
    });

    const body2Again = await tool('debug.step').execute('step-patched-value', {});
    assert.equal((body2Again.details as any).pause.scope.vars.value, 3);
    const completed = await tool('debug.continue').execute('continue', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 3});
});

test('durable patch overlays a checkpoint program after rewind and rebinds new checkpoint output', async () => {
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
            workspaceName: 'ws-program-patch-checkpoint',
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
    const tools = createPausedDslDebugAgentTools(execution, caller);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;

    const childLet = await tool('debug.step').execute('step-child-let', {});
    assert.equal((childLet.details as any).pause.location.programId, 'checkpoint:child');
    assert.equal((childLet.details as any).pause.location.path, 'body.0');
    await tool('debug.step').execute('step-child-output', {});
    const mainOutput = await tool('debug.step').execute('step-main-output', {});
    assert.equal((mainOutput.details as any).pause.location.programId, 'main');
    assert.deepEqual((mainOutput.details as any).pause.scope.vars.session, {value: 2});

    const patch = await tool('debug.patch_program').execute('patch-child', {
        programId: 'checkpoint:child',
        path: 'body.0',
        source: 'let picked = compute first(input.replacement)',
    });
    assert.equal((patch.details as any).status, 'rewind_required');
    assert.equal((patch.details as any).rewind.status, 'ready');
    const candidate = (patch.details as any).rewind.candidates[0];

    const rewound = await tool('debug.rewind').execute('rewind-child', {savepointId: candidate.savepointId});
    assert.equal((rewound.details as any).status, 'rewound');
    assert.equal((rewound.details as any).pause.location.programId, 'checkpoint:child');
    assert.deepEqual((rewound.details as any).pause.statement, {
        kind: 'let',
        name: 'picked',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.replacement'}}]}},
    });

    await tool('debug.step').execute('step-new-child-let', {});
    const rebound = await tool('debug.step').execute('step-new-child-output', {});
    assert.equal((rebound.details as any).pause.location.programId, 'main');
    assert.deepEqual((rebound.details as any).pause.scope.vars.session, {value: 9});
    const completed = await tool('debug.continue').execute('complete', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 9});
});

test('durable patches reject structural statement overlays so ProgramView paths remain stable', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            if input.enabled:
              output result = input.value
            output done = input.done
        `,
        context: {
            workspaceName: 'ws-program-patch-structural',
            deps,
            input: {enabled: true, value: 1, done: true},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    const pause = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const patch = tools.tools.find((tool) => tool.name === 'debug.patch_program')!;
    const result = await patch.execute('patch-structural', {
        programId: 'main',
        path: 'body.0',
        source: 'wait 0',
    });
    assert.equal((result.details as any).status, 'invalid');
    assert.equal((result.details as any).error.code, 'ERR_DSL_PATCH_UNSUPPORTED');
    assert.deepEqual(execution.patches(pause.continuationId), []);
    await execution.advance(pause.continuationId, 'abort');
});

test('durable patches reject variables unavailable at the target program point', async () => {
    const {execution, pause} = await createExecution();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const patch = tools.tools.find((tool) => tool.name === 'debug.patch_program')!;
    const result = await patch.execute('patch-missing-var', {
        programId: 'main',
        path: 'body.1',
        source: 'let value = compute first(vars.missing)',
    });
    assert.equal((result.details as any).status, 'invalid');
    assert.equal((result.details as any).error.code, 'ERR_DSL_PATCH_INVALID');
    assert.equal(
        (result.details as any).error.diagnostics.some(
            (diagnostic: {code: string}) => diagnostic.code === 'ERR_DSL_VAR_NOT_DEFINED',
        ),
        true,
    );
    assert.deepEqual(execution.patches(pause.continuationId), []);
    await execution.advance(pause.continuationId, 'abort');
});

test('transaction commit keeps durable program patches while invalidating old transaction rewind points', async () => {
    const {execution, pause} = await createExecution();
    const patch = execution.patchProgram(
        pause.continuationId,
        'main',
        'body.1',
        'let value = compute first(input.next)',
    );
    assert.equal(patch.status, 'patched');
    const beforeCommitPlan = execution.rewindPlan(pause.continuationId, {programId: 'main', path: 'body.0'});
    assert.equal(beforeCommitPlan.status, 'ready');

    const committed = await execution.commit(pause.continuationId);
    assert.equal(committed.status, 'committed');
    assert.equal(execution.patches(pause.continuationId).length, 1);
    const oldCandidate = beforeCommitPlan.status === 'ready' ? beforeCommitPlan.candidates[0] : null;
    if (!oldCandidate) {throw new Error('expected pre-commit rewind candidate');}
    assert.equal(execution.executionSavepoint(pause.continuationId, oldCandidate.savepointId), null);

    const next = await execution.advance(pause.continuationId, 'step');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected body.1 pause');}
    assert.equal(next.pause.reason, 'statement');
    if (next.pause.reason !== 'statement') {throw new Error('expected statement pause');}
    assert.equal(next.pause.location.path, 'body.1');
    assert.deepEqual(next.pause.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.next'}}]}},
    });
    await execution.advance(next.pause.continuationId, 'abort');
});
