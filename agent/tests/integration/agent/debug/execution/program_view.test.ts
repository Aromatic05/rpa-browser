import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createView = async (): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-program-view',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('debug.program exposes normalized statements on the same path coordinate system as execution', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            let ok = compute eq(input.enabled, true)
            if ok:
              output yes = input.value
            else:
              output no = input.value
            for item in input.items:
              output current = item
            wait 0
        `,
        context: {
            workspaceName: 'ws-program-view',
            deps: {} as RunStepsDeps,
            input: {enabled: true, value: 7, items: [1]},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'statement');
    const program = execution.program(pause.continuationId);
    assert.equal(program.programId, 'main');
    assert.deepEqual(program.statements.map((entry) => entry.path), [
        'body.0',
        'body.1',
        'body.1.then.0',
        'body.1.else.0',
        'body.2',
        'body.2.body.0',
        'body.3',
    ]);
    const first = program.statements[0];
    assert.equal(first.path, pause.location.path);
    assert.deepEqual(first.statement, pause.reason === 'statement' ? pause.statement : null);
    assert.deepEqual(first.source, pause.location.source);
    assert.deepEqual(first.statement, {
        kind: 'let',
        name: 'ok',
        expr: {
            kind: 'compute',
            expr: {op: 'eq', args: [{ref: {path: 'input.enabled'}}, {literal: true}]},
        },
    });

    const tools = createPausedDslDebugAgentTools(execution, pause);
    const programTool = tools.tools.find((tool) => tool.name === 'debug.program')!;
    const result = await programTool.execute('program', {});
    assert.deepEqual(
        (result.details as any).program.statements.map((entry: any) => entry.path),
        program.statements.map((entry) => entry.path),
    );

    const abort = tools.tools.find((tool) => tool.name === 'debug.abort')!;
    await abort.execute('abort', {});
});

test('debug.program follows the active checkpoint program and retains the parent program view', async () => {
    const view = await createView();
    const checkpoint = {
        id: 'child',
        kind: 'procedure' as const,
        body: {language: 'dsl' as const, source: 'body.dsl' as const},
    };
    const execution = createDslDebugExecutionSession({
        source: 'use checkpoint "child"\nwait 0',
        context: {
            workspaceName: 'ws-program-view',
            deps: {} as RunStepsDeps,
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
            checkpointProvider: {
                getCheckpoint: (id) => id === 'child' ? checkpoint : null,
                getCheckpointResolves: () => ({}),
                getCheckpointBody: (id) => id === 'child'
                    ? {source: 'wait 0', stepResolves: {}}
                    : null,
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakpoints: ['body.0']},
    });

    const mainPause = await execution.waitForPause();
    assert.equal(mainPause.location.programId, 'main');
    const entered = await execution.advance(mainPause.continuationId, 'continue');
    assert.equal(entered.status, 'paused');
    if (entered.status !== 'paused') {throw new Error('expected checkpoint pause');}
    const childPause = entered.pause;
    assert.equal(childPause.location.programId, 'checkpoint:child');

    const childProgram = execution.program(childPause.continuationId);
    assert.equal(childProgram.programId, 'checkpoint:child');
    assert.equal(childProgram.source, 'wait 0');
    assert.deepEqual(childProgram.statements.map((entry) => entry.path), ['body.0']);

    const parentProgram = execution.program(childPause.continuationId, 'main');
    assert.equal(parentProgram.programId, 'main');
    assert.deepEqual(parentProgram.statements.map((entry) => entry.path), ['body.0', 'body.1']);

    await execution.advance(childPause.continuationId, 'abort');
});
