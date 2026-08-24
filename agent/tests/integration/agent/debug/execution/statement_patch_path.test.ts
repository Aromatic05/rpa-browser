import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import type {RunStepsDeps} from '../../../../../src/automation/runner/run_steps';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
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
        workspaceName: 'ws-patch-path',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const patchTool = (
    execution: ReturnType<typeof createDslDebugExecutionSession>,
    pause: Awaited<ReturnType<ReturnType<typeof createDslDebugExecutionSession>['waitForPause']>>,
) => createPausedDslDebugAgentTools(execution, pause).tools.find((tool) => tool.name === 'debug.patch_statement')!;

test('path patch accepts the explicit current program point', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'wait 0\nwait 0',
        context: {
            workspaceName: 'ws-patch-path',
            deps,
            input: {value: 4},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    const pause = await execution.waitForPause();
    const patched = await patchTool(execution, pause).execute('patch-current', {
        source: 'output result = input.value',
        programId: 'main',
        path: 'body.0',
    });
    assert.equal((patched.details as any).status, 'patched');
    assert.equal((patched.details as any).pause.statement.kind, 'output');

    const stepped = await execution.advance(pause.continuationId, 'step');
    assert.equal(stepped.status, 'paused');
    if (stepped.status !== 'paused') {throw new Error('expected pause');}
    assert.deepEqual(stepped.pause.scope.output, {result: 4});
    await execution.advance(stepped.pause.continuationId, 'abort');
});

test('path patch returns rewind_required for executed points and not_current for future points', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'wait 0\nwait 0\nwait 0',
        context: {
            workspaceName: 'ws-patch-path',
            deps,
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    const first = await execution.waitForPause();
    const secondResult = await execution.advance(first.continuationId, 'step');
    assert.equal(secondResult.status, 'paused');
    if (secondResult.status !== 'paused') {throw new Error('expected pause');}
    const second = secondResult.pause;
    const patch = patchTool(execution, second);

    const executed = await patch.execute('patch-executed', {
        source: 'wait 0',
        programId: 'main',
        path: 'body.0',
    });
    assert.equal((executed.details as any).status, 'rewind_required');
    assert.deepEqual((executed.details as any).target, {
        programId: 'main',
        path: 'body.0',
        executions: 1,
    });

    const future = await patch.execute('patch-future', {
        source: 'wait 0',
        programId: 'main',
        path: 'body.2',
    });
    assert.equal((future.details as any).status, 'not_current');
    assert.deepEqual((future.details as any).target, {
        programId: 'main',
        path: 'body.2',
        executions: 0,
    });

    await execution.advance(second.continuationId, 'abort');
});

test('path patch reports unknown program and path without touching the continuation', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'wait 0',
        context: {
            workspaceName: 'ws-patch-path',
            deps,
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    const pause = await execution.waitForPause();
    const patch = patchTool(execution, pause);

    const missingProgram = await patch.execute('patch-program', {
        source: 'wait 0',
        programId: 'checkpoint:missing',
        path: 'body.0',
    });
    assert.equal((missingProgram.details as any).status, 'unknown_program');

    const missingPath = await patch.execute('patch-path', {
        source: 'wait 0',
        programId: 'main',
        path: 'body.99',
    });
    assert.equal((missingPath.details as any).status, 'unknown_path');

    assert.equal((await execution.program(pause.continuationId)).programId, 'main');
    await execution.advance(pause.continuationId, 'abort');
});

test('current loop iteration remains patchable even when the same path executed earlier', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            for item in input.items:
              wait 0
            wait 0
        `,
        context: {
            workspaceName: 'ws-patch-path',
            deps,
            input: {items: ['a', 'b'], value: 8},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });
    const parent = await execution.waitForPause();
    const firstIterationResult = await execution.advance(parent.continuationId, 'step');
    assert.equal(firstIterationResult.status, 'paused');
    if (firstIterationResult.status !== 'paused') {throw new Error('expected first loop pause');}
    const firstIteration = firstIterationResult.pause;
    const secondIterationResult = await execution.advance(firstIteration.continuationId, 'step');
    assert.equal(secondIterationResult.status, 'paused');
    if (secondIterationResult.status !== 'paused') {throw new Error('expected second loop pause');}
    const secondIteration = secondIterationResult.pause;
    assert.equal(secondIteration.location.path, 'body.0.body.0');

    const history = execution.history(secondIteration.continuationId);
    const point = history.points.find((entry) => entry.path === 'body.0.body.0');
    assert.deepEqual(point, {path: 'body.0.body.0', state: 'current', executions: 1});

    const patched = await patchTool(execution, secondIteration).execute('patch-loop-current', {
        source: 'output patched = input.value',
        programId: 'main',
        path: 'body.0.body.0',
    });
    assert.equal((patched.details as any).status, 'patched');

    const next = await execution.advance(secondIteration.continuationId, 'step');
    assert.equal(next.status, 'paused');
    if (next.status !== 'paused') {throw new Error('expected next pause');}
    assert.equal(next.pause.location.path, 'body.1');
    assert.deepEqual(next.pause.scope.output, {patched: 8});
    await execution.advance(next.pause.continuationId, 'abort');
});
