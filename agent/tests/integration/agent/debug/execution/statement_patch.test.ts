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
        workspaceName: 'ws-patch',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('debug.patch_statement replaces the current unexecuted statement in the retained continuation', async () => {
    const view = await createView();
    let stepCalls = 0;
    const execution = createDslDebugExecutionSession({
        source: `
            let value = compute first(input.old)
            output result = vars.value
        `,
        context: {
            workspaceName: 'ws-patch',
            deps,
            input: {old: [1], next: [2]},
            stepExecutionPort: {
                execute: async (step) => {
                    stepCalls += 1;
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const first = await execution.waitForPause();
    assert.equal(first.reason, 'statement');
    if (first.reason !== 'statement') {throw new Error('expected statement pause');}
    assert.deepEqual(first.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.old'}}]}},
    });

    const tools = createPausedDslDebugAgentTools(execution, first);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;
    const patched = await tool('debug.patch_statement').execute('patch', {
        source: 'let value = compute first(input.next)',
    });
    assert.equal((patched.details as any).status, 'patched');
    assert.deepEqual((patched.details as any).pause.statement, {
        kind: 'let',
        name: 'value',
        expr: {kind: 'compute', expr: {op: 'first', args: [{ref: {path: 'input.next'}}]}},
    });

    const stepped = await tool('debug.step').execute('step', {});
    assert.equal((stepped.details as any).status, 'paused');
    assert.equal((stepped.details as any).pause.location.path, 'body.1');
    assert.equal((stepped.details as any).pause.scope.vars.value, 2);
    assert.equal(stepCalls, 0);

    const completed = await tool('debug.continue').execute('continue', {});
    assert.equal((completed.details as any).status, 'completed');
    assert.deepEqual((completed.details as any).output, {result: 2});
    assert.equal(stepCalls, 0);
});

test('patching a pending click to wait prevents the original World effect', async () => {
    const view = await createView();
    const calls: string[] = [];
    const execution = createDslDebugExecutionSession({
        source: `
            click input.target
            output result = input.result
        `,
        context: {
            workspaceName: 'ws-patch',
            deps,
            input: {target: {nodeId: 'old-button'}, result: 'ok'},
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(step.name);
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {initialMode: 'step'},
    });

    const pause = await execution.waitForPause();
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const tool = (name: string) => tools.tools.find((candidate) => candidate.name === name)!;
    const patched = await tool('debug.patch_statement').execute('patch', {source: 'wait 0'});
    assert.equal((patched.details as any).status, 'patched');

    const stepped = await tool('debug.step').execute('step', {});
    assert.equal((stepped.details as any).status, 'paused');
    assert.deepEqual(calls, []);
    await tool('debug.abort').execute('abort', {});
});

test('statement patch is unavailable after execution has entered an effect pause', async () => {
    const view = await createView();
    const calls: string[] = [];
    const execution = createDslDebugExecutionSession({
        source: 'click input.target',
        context: {
            workspaceName: 'ws-patch',
            deps,
            input: {target: {nodeId: 'button'}},
            stepExecutionPort: {
                execute: async (step) => {
                    calls.push(step.name);
                    return {stepId: step.id, ok: true, data: {}};
                },
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakBeforeEffects: true},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'effect');
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const patch = tools.tools.find((tool) => tool.name === 'debug.patch_statement')!;
    const result = await patch.execute('patch', {source: 'wait 0'});
    assert.equal((result.details as any).status, 'unavailable');
    assert.equal((result.details as any).reason, 'not_statement_pause');
    assert.deepEqual(calls, []);

    const abort = tools.tools.find((tool) => tool.name === 'debug.abort')!;
    await abort.execute('abort', {});
    assert.deepEqual(calls, []);
});

test('statement patch is unavailable at a failure pause', async () => {
    const view = await createView();
    const execution = createDslDebugExecutionSession({
        source: 'ensure compute eq(input.actual, input.expected)',
        context: {
            workspaceName: 'ws-patch',
            deps,
            input: {actual: 1, expected: 2},
            stepExecutionPort: {
                execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
            },
        },
        worldViewSource: {pin: async () => view},
        debug: {breakOnFailure: true},
    });

    const pause = await execution.waitForPause();
    assert.equal(pause.reason, 'failure');
    const tools = createPausedDslDebugAgentTools(execution, pause);
    const patch = tools.tools.find((tool) => tool.name === 'debug.patch_statement')!;
    const result = await patch.execute('patch', {source: 'wait 0'});
    assert.equal((result.details as any).status, 'unavailable');
    assert.equal((result.details as any).reason, 'not_statement_pause');

    const abort = tools.tools.find((tool) => tool.name === 'debug.abort')!;
    await abort.execute('abort', {});
});
