import test from 'node:test';
import assert from 'node:assert/strict';
import {createDslDebugController} from '../../../../src/dsl/debug/controller';
import {runDsl} from '../../../../src/dsl/runtime/run_dsl';
import type {DslProgram} from '../../../../src/dsl/ast/types';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;

test('effect breakpoint pauses after linked query but before the browser mutation', async () => {
    const controller = createDslDebugController({breakBeforeEffects: true} as never);
    const calls: string[] = [];
    const program: DslProgram = {
        body: [{
            kind: 'linked_entity_act',
            action: 'click',
            targetQuery: {
                kind: 'query',
                op: 'entity.target',
                businessTag: 'orders.main',
                payload: {kind: 'table.module_action', actionIntent: 'approve'},
            },
        }],
    };
    const run = runDsl(program, {
        workspaceName: 'ws-1',
        deps,
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                if (step.name === 'browser.query') {
                    return {
                        stepId: step.id,
                        ok: true,
                        data: {kind: 'nodeId', nodeId: 'approve-button'},
                    };
                }
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
        },
    });

    const paused = await Promise.race([
        controller.waitForPause(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('effect pause not reached')), 100)),
    ]);
    assert.equal(paused.reason, 'effect');
    assert.equal(paused.location.path, 'body.0');
    assert.deepEqual((paused as any).effect, {
        stepId: (paused as any).effect.stepId,
        stepName: 'browser.click',
        args: {nodeId: 'approve-button'},
    });
    assert.deepEqual(calls, ['browser.query']);

    controller.continue(paused.continuationId);
    await run;
    assert.deepEqual(calls, ['browser.query', 'browser.click']);
});

test('effect breakpoints ignore read-only DSL steps', async () => {
    const controller = createDslDebugController({breakBeforeEffects: true} as never);
    const calls: string[] = [];
    const program: DslProgram = {
        body: [{
            kind: 'let',
            name: 'rows',
            expr: {
                kind: 'query',
                op: 'entity',
                businessTag: 'orders.main',
                payload: 'table.currentRows',
            },
        }],
    };
    const run = runDsl(program, {
        workspaceName: 'ws-1',
        deps,
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                return {
                    stepId: step.id,
                    ok: true,
                    data: {kind: 'value', value: []},
                };
            },
        },
    });

    await run;
    assert.deepEqual(calls, ['browser.query']);
});

test('effect breakpoint also guards legacy checkpoint action steps before execution', async () => {
    const controller = createDslDebugController({breakBeforeEffects: true});
    const calls: string[] = [];
    const run = runDsl({body: [{kind: 'checkpoint', id: 'legacy'}]}, {
        workspaceName: 'ws-1',
        deps,
        debugPort: controller.port,
        checkpointProvider: {
            getCheckpoint: () => ({
                id: 'legacy',
                content: [{type: 'act', step: {name: 'browser.click', args: {selector: '#legacy'}}}],
            }),
        },
        stepExecutionPort: {
            execute: async (step) => {
                calls.push(step.name);
                return {stepId: step.id, ok: true, data: {clicked: true}};
            },
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.reason, 'effect');
    if (paused.reason !== 'effect') {throw new Error('expected effect pause');}
    assert.equal(paused.location.path, 'body.0');
    assert.equal(paused.effect.stepName, 'browser.click');
    assert.deepEqual(calls, []);

    controller.continue(paused.continuationId);
    await run;
    assert.deepEqual(calls, ['browser.click']);
});
