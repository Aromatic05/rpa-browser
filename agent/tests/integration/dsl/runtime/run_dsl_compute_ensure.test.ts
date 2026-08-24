import test from 'node:test';
import assert from 'node:assert/strict';
import {runDslSource} from '../../../../src/automation/dsl/runtime';
import {DslRuntimeError} from '../../../../src/program/dsl/diagnostics/errors';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';

const deps = {} as RunStepsDeps;

test('DSL compute is pure and emits no browser steps', async () => {
    const calls: string[] = [];
    const result = await runDslSource(`
        let count = compute len(input.items)
        let ok = compute eq(count, input.expected)
        ensure ok
        output result = ok
    `, {
        workspaceName: 'ws-compute',
        deps,
        input: {items: ['a', 'b'], expected: 2},
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                return {stepId: step.id, ok: true, data: {}};
            },
        },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result.scope.vars, {count: 2, ok: true});
    assert.deepEqual(result.scope.output, {result: true});
});

test('ensure failure stops before a later browser effect', async () => {
    let clickCalls = 0;
    await assert.rejects(runDslSource(`
        ensure compute eq(input.actual, input.expected)
        click input.target
    `, {
        workspaceName: 'ws-compute',
        deps,
        input: {actual: 1, expected: 2, target: {nodeId: 'submit'}},
        stepExecutionPort: {
            execute: async (step) => {
                clickCalls += 1;
                return {stepId: step.id, ok: true, data: {}};
            },
        },
    }), (error: unknown) =>
        error instanceof DslRuntimeError
        && error.code === 'ERR_DSL_ENSURE_FAILED'
        && (error.details as {expected?: unknown})?.expected === true
        && (error.details as {actual?: unknown})?.actual === false);
    assert.equal(clickCalls, 0);
});

test('compute expressions execute in output if and for positions without browser steps', async () => {
    const calls: string[] = [];
    const result = await runDslSource(`
        if compute eq(input.enabled, true):
          output branch = compute eq(input.value, 7)
        for item in compute get(input.groups, 0):
          output current = item
    `, {
        workspaceName: 'ws-compute',
        deps,
        input: {enabled: true, value: 7, groups: [['a', 'b']]},
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                return {stepId: step.id, ok: true, data: {}};
            },
        },
    });

    assert.deepEqual(calls, []);
    assert.deepEqual(result.scope.output, {branch: true, current: 'b'});
});
