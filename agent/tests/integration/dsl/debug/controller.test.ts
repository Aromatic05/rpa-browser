import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugController} from '../../../../src/automation/dsl/debug/controller';
import {runDslSource} from '../../../../src/automation/dsl/runtime';
import type {RunStepsDeps} from '../../../../src/automation/runner/run_steps';
import type {StepUnion} from '../../../../src/automation/runner/steps/types';

const deps = {} as RunStepsDeps;
const noopPort = {
    execute: async (step: StepUnion) => ({stepId: step.id, ok: true, data: {}}),
};

test('DSL debugger pauses before statements and step continues from the retained continuation', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const run = runDslSource(`
        output first = input.value
        output second = output.first
        output result = output.second
    `, {
        workspaceName: 'ws-1',
        deps,
        input: {value: 7},
        stepExecutionPort: noopPort,
        debugPort: controller.port,
    });

    const first = await controller.waitForPause();
    assert.equal(first.location.path, 'body.0');
    assert.equal(first.location.kind, 'output');
    assert.deepEqual(first.location.source, {line: 2, column: 1, endLine: 2, endColumn: 27});
    assert.deepEqual(first.location.callStack, []);
    assert.deepEqual(first.scope.vars, {});
    assert.equal(Object.isFrozen(first.scope.vars), true);

    controller.step(first.continuationId);
    const second = await controller.waitForPause();
    assert.equal(second.location.path, 'body.1');
    assert.deepEqual(second.scope.output, {first: 7});

    controller.step(second.continuationId);
    const third = await controller.waitForPause();
    assert.equal(third.location.path, 'body.2');
    assert.deepEqual(third.scope.output, {first: 7, second: 7});

    controller.continue(third.continuationId);
    const result = await run;
    assert.deepEqual(result.scope.output, {first: 7, second: 7, result: 7});
});

test('DSL debugger uses nested program paths and loop frames', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const run = runDslSource(`
        if input.enabled:
          for item in input.items:
            output selected = item
        output result = input.enabled
    `, {
        workspaceName: 'ws-1',
        deps,
        input: {enabled: true, items: ['a', 'b']},
        stepExecutionPort: noopPort,
        debugPort: controller.port,
    });

    const ifPause = await controller.waitForPause();
    assert.equal(ifPause.location.path, 'body.0');
    controller.step(ifPause.continuationId);

    const forPause = await controller.waitForPause();
    assert.equal(forPause.location.path, 'body.0.then.0');
    controller.step(forPause.continuationId);

    const firstIteration = await controller.waitForPause();
    assert.equal(firstIteration.location.path, 'body.0.then.0.body.0');
    assert.deepEqual(firstIteration.location.loops, [{path: 'body.0.then.0', iteration: 0}]);
    assert.equal(firstIteration.scope.vars.item, 'a');
    controller.step(firstIteration.continuationId);

    const secondIteration = await controller.waitForPause();
    assert.equal(secondIteration.location.path, 'body.0.then.0.body.0');
    assert.deepEqual(secondIteration.location.loops, [{path: 'body.0.then.0', iteration: 1}]);
    assert.equal(secondIteration.scope.vars.item, 'b');
    controller.continue(secondIteration.continuationId);

    await run;
});

test('DSL breakpoint pause does not replay already executed effects', async () => {
    const controller = createDslDebugController({breakpoints: ['body.1']});
    let snapshotCalls = 0;
    const run = runDslSource(`
        snapshot
        output value = input.value
        output result = output.value
    `, {
        workspaceName: 'ws-1',
        deps,
        input: {value: 3},
        stepExecutionPort: {
            execute: async (step) => {
                if (step.name === 'browser.snapshot') {snapshotCalls += 1;}
                return {stepId: step.id, ok: true, data: {}};
            },
        },
        debugPort: controller.port,
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.location.path, 'body.1');
    assert.equal(snapshotCalls, 1);

    controller.step(paused.continuationId);
    const next = await controller.waitForPause();
    assert.equal(next.location.path, 'body.2');
    assert.equal(snapshotCalls, 1);

    controller.continue(next.continuationId);
    await run;
    assert.equal(snapshotCalls, 1);
});

test('DSL debugger steps into checkpoint DSL bodies with an independent program id', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const checkpoint = {
        id: 'ensure',
        kind: 'procedure' as const,
        input: {value: 5},
        body: {language: 'dsl' as const, source: 'body.dsl' as const},
    };
    const run = runDslSource(`
        use checkpoint "ensure"
        output done = input.done
    `, {
        workspaceName: 'ws-1',
        deps,
        input: {done: true},
        stepExecutionPort: noopPort,
        checkpointProvider: {
            getCheckpoint: (id) => id === checkpoint.id ? checkpoint : null,
            getCheckpointResolves: () => ({}),
            getCheckpointBody: () => ({
                source: 'output inside = input.value',
                stepResolves: {},
            }),
        },
        debugPort: controller.port,
    });

    const call = await controller.waitForPause();
    assert.equal(call.location.programId, 'main');
    assert.equal(call.location.path, 'body.0');
    assert.equal(call.location.kind, 'checkpoint');
    controller.step(call.continuationId);

    const body = await controller.waitForPause();
    assert.equal(body.location.programId, 'checkpoint:ensure');
    assert.equal(body.location.path, 'body.0');
    assert.deepEqual(body.location.source, {line: 1, column: 1, endLine: 1, endColumn: 28});
    assert.deepEqual(body.location.callStack, ['ensure']);
    assert.deepEqual(body.scope.input, {value: 5});
    controller.continue(body.continuationId);

    await run;
});

test('DSL debugger preserves the full nested checkpoint call stack', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const checkpoints = new Map([
        ['outer', {id: 'outer', kind: 'procedure' as const, body: {language: 'dsl' as const, source: 'body.dsl' as const}}],
        ['inner', {id: 'inner', kind: 'procedure' as const, input: {value: true}, body: {language: 'dsl' as const, source: 'body.dsl' as const}}],
    ]);
    const run = runDslSource('use checkpoint "outer"', {
        workspaceName: 'ws-1',
        deps,
        stepExecutionPort: noopPort,
        checkpointProvider: {
            getCheckpoint: (id) => checkpoints.get(id) ?? null,
            getCheckpointResolves: () => ({}),
            getCheckpointBody: (id) => id === 'outer'
                ? {source: 'use checkpoint "inner"', stepResolves: {}}
                : {source: 'output nested = input.value', stepResolves: {}},
        },
        debugPort: controller.port,
    });

    const main = await controller.waitForPause();
    assert.deepEqual(main.location.callStack, []);
    controller.step(main.continuationId);

    const outer = await controller.waitForPause();
    assert.equal(outer.location.programId, 'checkpoint:outer');
    assert.deepEqual(outer.location.callStack, ['outer']);
    controller.step(outer.continuationId);

    const inner = await controller.waitForPause();
    assert.equal(inner.location.programId, 'checkpoint:inner');
    assert.deepEqual(inner.location.callStack, ['outer', 'inner']);
    assert.deepEqual(inner.location.source, {line: 1, column: 1, endLine: 1, endColumn: 28});
    controller.continue(inner.continuationId);

    await run;
});
