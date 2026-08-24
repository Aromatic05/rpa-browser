import test from 'node:test';
import assert from 'node:assert/strict';
import {runDslSource} from '../../../../src/program/dsl/runtime';
import type {DslDebugPort} from '../../../../src/program/dsl/debug/contracts';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

const deps = {} as RunStepsDeps;

test('DSL debug port reports query, compute and ref value provenance without changing scope values', async () => {
    const events: unknown[] = [];
    const debugPort: DslDebugPort = {
        beforeStatement: () => undefined,
        onValue: (event) => {events.push(event);},
    } as DslDebugPort;
    const result = await runDslSource(`
        let buyer = query entity.target "order.form" {
          kind: "form.field"
          fieldKey: "buyer"
        }
        let present = compute exists(buyer)
        output selected = buyer
    `, {
        workspaceName: 'ws-provenance',
        deps,
        debugPort,
        stepExecutionPort: {
            execute: async (step) => step.name === 'browser.query'
                ? {
                    stepId: step.id,
                    ok: true,
                    data: {
                        kind: 'nodeId',
                        nodeId: 'buyer-input',
                        meta: {pageEpoch: 'epoch-1', captureRevision: 7},
                    },
                }
                : {stepId: step.id, ok: true, data: {}},
        },
    });

    assert.equal((result.scope.vars.buyer as {nodeId: string}).nodeId, 'buyer-input');
    assert.equal(result.scope.vars.present, true);
    assert.deepEqual(result.scope.output.selected, result.scope.vars.buyer);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event: any) => ({
        target: event.target,
        kind: event.source.kind,
        dependencies: event.source.dependencies,
        observedAt: event.source.observedAt,
    })), [
        {
            target: 'vars.buyer',
            kind: 'query',
            dependencies: [],
            observedAt: {pageEpoch: 'epoch-1', captureRevision: 7},
        },
        {
            target: 'vars.present',
            kind: 'compute',
            dependencies: ['vars.buyer'],
            observedAt: undefined,
        },
        {
            target: 'output.selected',
            kind: 'ref',
            dependencies: ['vars.buyer'],
            observedAt: undefined,
        },
    ]);
    assert.equal((events[0] as any).source.stepId.length > 0, true);
    assert.deepEqual((events[0] as any).source.query, {
        op: 'entity.target',
        businessTag: 'order.form',
        target: {kind: 'form.field', fieldKey: 'buyer'},
    });
    assert.equal((events[0] as any).location.path, 'body.0');
});

test('value provenance distinguishes checkpoint frames and loop iterations', async () => {
    const events: any[] = [];
    const debugPort: DslDebugPort = {
        beforeStatement: () => undefined,
        onValue: (event) => {events.push(event);},
    };
    const result = await runDslSource(`
        let session = use checkpoint "ensure" with {
          authenticated: input.authenticated
        }
        for item in input.items:
          output current = item
    `, {
        workspaceName: 'ws-provenance',
        deps,
        input: {authenticated: 'alice', items: ['a', 'b']},
        debugPort,
        checkpointProvider: {
            getCheckpoint: (id) => id === 'ensure'
                ? {id, kind: 'procedure', body: {language: 'dsl', source: 'body.dsl'}}
                : null,
            getCheckpointResolves: () => ({}),
            getCheckpointBody: () => ({
                source: 'output authenticated = input.authenticated',
                stepResolves: {},
            }),
        },
        stepExecutionPort: {
            execute: async (step) => ({stepId: step.id, ok: true, data: {}}),
        },
    });

    assert.deepEqual(result.scope.vars.session, {authenticated: 'alice'});
    assert.deepEqual(result.scope.output, {current: 'b'});

    const checkpointOutput = events.find((event) =>
        event.location.programId === 'checkpoint:ensure' && event.target === 'output.authenticated');
    assert.equal(checkpointOutput.source.kind, 'ref');
    assert.deepEqual(checkpointOutput.source.dependencies, ['input.authenticated']);

    const binding = events.find((event) =>
        event.location.programId === 'main' && event.target === 'vars.session');
    assert.equal(binding.source.kind, 'checkpoint');
    assert.equal(binding.source.checkpointId, 'ensure');
    assert.deepEqual(binding.source.dependencies, ['input.authenticated']);

    const loopEvents = events.filter((event) =>
        event.location.programId === 'main'
        && event.target === 'vars.item'
        && event.source.kind === 'loop');
    assert.deepEqual(loopEvents.map((event) => ({
        iteration: event.source.iteration,
        dependencies: event.source.dependencies,
    })), [
        {iteration: 0, dependencies: ['input.items']},
        {iteration: 1, dependencies: ['input.items']},
    ]);
});
