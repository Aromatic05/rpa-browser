import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDsl, parseDslDocument} from '../../../../src/program/dsl/parser';
import {createDslDebugController} from '../../../../src/program/dsl/debug/controller';
import {runDslSource} from '../../../../src/program/dsl/runtime';
import type {RunStepsDeps} from '../../../../src/runner/run_steps';

test('parseDslDocument maps executable paths to source lines without changing the AST', () => {
    const source = [
        'if input.enabled:',
        '  for item in input.items:',
        '    output chosen = item',
        'else:',
        '  output chosen = input.fallback',
        '',
        'let target = query entity.target "orders.main" {',
        '  kind: "table.module_action"',
        '  actionIntent: "approve"',
        '}',
        'click target',
    ].join('\n');

    const document = parseDslDocument(source);

    assert.deepEqual(document.program, parseDsl(source));
    assert.deepEqual(document.sourceMap, {
        'body.0': {line: 1, column: 1, endLine: 1, endColumn: 18},
        'body.0.then.0': {line: 2, column: 3, endLine: 2, endColumn: 27},
        'body.0.then.0.body.0': {line: 3, column: 5, endLine: 3, endColumn: 25},
        'body.0.else.0': {line: 5, column: 3, endLine: 5, endColumn: 33},
        'body.1': {line: 7, column: 1, endLine: 10, endColumn: 2},
        'body.2': {line: 11, column: 1, endLine: 11, endColumn: 13},
    });
    assert.equal('source' in document.program.body[0], false);
});

test('source map keeps physical line numbers while normalizing common indentation', () => {
    const source = `
        output first = input.first

        output second = input.second
    `;
    const document = parseDslDocument(source);

    assert.deepEqual(document.sourceMap, {
        'body.0': {line: 2, column: 1, endLine: 2, endColumn: 27},
        'body.1': {line: 4, column: 1, endLine: 4, endColumn: 29},
    });
});

test('runtime source locations stay aligned after DSL normalization', async () => {
    const controller = createDslDebugController({initialMode: 'step'});
    const run = runDslSource(`
        fill form "order.form" field "buyer" with input.user.name
    `, {
        workspaceName: 'ws-source-map',
        deps: {} as RunStepsDeps,
        input: {user: {name: 'alice'}},
        debugPort: controller.port,
        stepExecutionPort: {
            execute: async (step) => step.name === 'browser.query'
                ? {stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'buyer-input'}}
                : {stepId: step.id, ok: true, data: {}},
        },
    });

    const paused = await controller.waitForPause();
    assert.equal(paused.location.path, 'body.0');
    assert.equal(paused.location.kind, 'linked_entity_act');
    assert.deepEqual(paused.location.source, {line: 2, column: 1, endLine: 2, endColumn: 58});

    controller.continue(paused.continuationId);
    await run;
});
