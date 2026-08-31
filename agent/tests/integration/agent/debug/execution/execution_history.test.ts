import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugExecutionSession} from '../../../../../src/agent/debug/execution/dsl_session';
import {createPausedDslDebugAgentTools} from '../../../../../src/agent/debug/execution/agent_tools';
import {classifyPausedDslDebugToolCall} from '../../../../../src/agent/debug/execution/tool_policy';
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
        workspaceName: 'ws-history',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

const historyTool = (
    execution: ReturnType<typeof createDslDebugExecutionSession>,
    pause: Awaited<ReturnType<ReturnType<typeof createDslDebugExecutionSession>['waitForPause']>>,
) => createPausedDslDebugAgentTools(execution, pause).tools.find((tool) => tool.name === 'debug.history')!;

test('debug.history classifies current, executed and unexecuted program points', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            output first = input.first
            output second = input.second
            wait 0
        `,
        context: {
            workspaceName: 'ws-history',
            deps,
            input: {first: 1, second: 2},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const first = await execution.waitForPause();
    const initial = await historyTool(execution, first).execute('history-initial', {});
    assert.deepEqual((initial.details as any).history.records, []);
    assert.deepEqual((initial.details as any).history.points.map((point: any) => [point.path, point.state, point.executions]), [
        ['body.0', 'current', 0],
        ['body.1', 'unexecuted', 0],
        ['body.2', 'unexecuted', 0],
    ]);

    const stepped = await execution.advance(first.continuationId, 'step');
    assert.equal(stepped.status, 'paused');
    if (stepped.status !== 'paused') {throw new Error('expected pause');}
    const next = stepped.pause;
    const after = await historyTool(execution, next).execute('history-after', {});
    assert.equal((after.details as any).history.records.length, 1);
    assert.equal((after.details as any).history.records[0].sequence, 1);
    assert.equal((after.details as any).history.records[0].location.path, 'body.0');
    assert.equal((after.details as any).history.records[0].statement.kind, 'output');
    assert.deepEqual((after.details as any).history.points.map((point: any) => [point.path, point.state, point.executions]), [
        ['body.0', 'executed', 1],
        ['body.1', 'current', 0],
        ['body.2', 'unexecuted', 0],
    ]);
    assert.equal(classifyPausedDslDebugToolCall('debug.history'), 'read');

    await execution.advance(next.continuationId, 'abort');
});

test('statement history distinguishes loop iterations and records the actually patched statement', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: `
            wait 0
            for item in input.items:
              output current = item
            wait 0
        `,
        context: {
            workspaceName: 'ws-history',
            deps,
            input: {items: ['a', 'b'], patched: 7},
            stepExecutionPort: {execute: async (step) => ({stepId: step.id, ok: true, data: {}})},
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const first = await execution.waitForPause();
    assert.equal(first.reason, 'statement');
    const tools = createPausedDslDebugAgentTools(execution, first);
    const patch = tools.tools.find((tool) => tool.name === 'debug.patch_statement')!;
    const patched = await patch.execute('patch-first', {source: 'output patched = input.patched'});
    assert.equal((patched.details as any).status, 'patched');

    const nextResult = await execution.advance(first.continuationId, 'step');
    assert.equal(nextResult.status, 'paused');
    if (nextResult.status !== 'paused') {throw new Error('expected second pause');}
    const second = nextResult.pause;
    const afterPatch = await historyTool(execution, second).execute('history-patch', {});
    assert.equal((afterPatch.details as any).history.records[0].statement.kind, 'output');
    assert.equal((afterPatch.details as any).history.records[0].statement.name, 'patched');

    const loopPauseResult = await execution.advance(second.continuationId, 'step');
    assert.equal(loopPauseResult.status, 'paused');
    if (loopPauseResult.status !== 'paused') {throw new Error('expected loop pause');}
    const loopFirst = loopPauseResult.pause;
    assert.equal(loopFirst.location.path, 'body.1.body.0');

    const loopSecondResult = await execution.advance(loopFirst.continuationId, 'step');
    assert.equal(loopSecondResult.status, 'paused');
    if (loopSecondResult.status !== 'paused') {throw new Error('expected second loop pause');}
    const loopSecond = loopSecondResult.pause;
    assert.equal(loopSecond.location.path, 'body.1.body.0');
    const history = await historyTool(execution, loopSecond).execute('history-loop', {});
    const loopRecords = (history.details as any).history.records.filter(
        (record: any) => record.location.path === 'body.1.body.0',
    );
    assert.equal(loopRecords.length, 1);
    assert.deepEqual(loopRecords[0].location.loops, [{path: 'body.1', iteration: 0}]);

    const afterLoopResult = await execution.advance(loopSecond.continuationId, 'step');
    assert.equal(afterLoopResult.status, 'paused');
    if (afterLoopResult.status !== 'paused') {throw new Error('expected pause after loop');}
    const afterLoop = afterLoopResult.pause;
    assert.equal(afterLoop.location.path, 'body.2');
    const completedLoopHistory = await historyTool(execution, afterLoop).execute('history-loop-complete', {});
    const completedLoopRecords = (completedLoopHistory.details as any).history.records.filter(
        (record: any) => record.location.path === 'body.1.body.0',
    );
    assert.equal(completedLoopRecords.length, 2);
    assert.deepEqual(completedLoopRecords.map((record: any) => record.location.loops), [
        [{path: 'body.1', iteration: 0}],
        [{path: 'body.1', iteration: 1}],
    ]);
    const loopPoint = (completedLoopHistory.details as any).history.points.find(
        (point: any) => point.path === 'body.1.body.0',
    );
    assert.deepEqual(loopPoint, {path: 'body.1.body.0', state: 'executed', executions: 2});

    await execution.advance(afterLoop.continuationId, 'abort');
});

test('failed statements are not recorded as successful history', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-history',
            deps,
            input: {target: {nodeId: 'missing'}},
            stepExecutionPort: {
                execute: async (step) => ({
                    stepId: step.id,
                    ok: false,
                    error: {code: 'ERR_NOT_FOUND', message: 'missing'},
                }),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
    });

    const failure = await execution.waitForPause();
    assert.equal(failure.reason, 'failure');
    const history = await historyTool(execution, failure).execute('history-failure', {});
    assert.deepEqual((history.details as any).history.records, []);
    assert.deepEqual((history.details as any).history.points.map((point: any) => [point.path, point.state]), [
        ['body.0', 'unexecuted'],
    ]);

    await execution.advance(failure.continuationId, 'abort');
});

test('statement history spans checkpoint programs while preserving program-local views', async () => {
    const view = await createView();
    const checkpoint = {
        id: 'child',
        kind: 'procedure' as const,
        body: {language: 'dsl' as const, source: 'body.dsl' as const},
    };
    const execution = createDslDebugExecutionSession({
        source: 'use checkpoint "child"\nwait 0',
        context: {
            workspaceName: 'ws-history',
            deps,
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
        debug: {initialMode: 'step'},
    });

    const main = await execution.waitForPause();
    const childResult = await execution.advance(main.continuationId, 'step');
    assert.equal(childResult.status, 'paused');
    if (childResult.status !== 'paused') {throw new Error('expected child pause');}
    const child = childResult.pause;
    assert.equal(child.location.programId, 'checkpoint:child');

    const nextMainResult = await execution.advance(child.continuationId, 'step');
    assert.equal(nextMainResult.status, 'paused');
    if (nextMainResult.status !== 'paused') {throw new Error('expected main pause');}
    const nextMain = nextMainResult.pause;
    assert.equal(nextMain.location.programId, 'main');
    assert.equal(nextMain.location.path, 'body.1');

    const childHistory = await historyTool(execution, nextMain).execute('history-child', {
        programId: 'checkpoint:child',
    });
    assert.deepEqual((childHistory.details as any).history.records.map((record: any) => [
        record.location.programId,
        record.location.path,
        record.sequence,
    ]), [['checkpoint:child', 'body.0', 1]]);

    const mainHistory = await historyTool(execution, nextMain).execute('history-main', {programId: 'main'});
    assert.deepEqual((mainHistory.details as any).history.records.map((record: any) => [
        record.location.programId,
        record.location.path,
        record.sequence,
    ]), [['main', 'body.0', 2]]);

    await execution.advance(nextMain.continuationId, 'abort');
});
