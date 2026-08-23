import test from 'node:test';
import assert from 'node:assert/strict';
import {parseDsl} from '../../../../src/dsl/parser';
import {DslParseError} from '../../../../src/dsl/diagnostics/errors';

test('parseDsl parses nested compute expressions and ensure', () => {
    const program = parseDsl(`
        let count = compute len(rows)
        let ok = compute and(eq(count, input.expected), exists(rows))
        ensure compute eq(ok, true)
        output final = compute not(ok)
    `);

    assert.deepEqual(program.body, [
        {
            kind: 'let',
            name: 'count',
            expr: {kind: 'compute', expr: {op: 'len', args: [{ref: {path: 'rows'}}]}},
        },
        {
            kind: 'let',
            name: 'ok',
            expr: {
                kind: 'compute',
                expr: {
                    op: 'and',
                    args: [
                        {op: 'eq', args: [{ref: {path: 'count'}}, {ref: {path: 'input.expected'}}]},
                        {op: 'exists', args: [{ref: {path: 'rows'}}]},
                    ],
                },
            },
        },
        {
            kind: 'ensure',
            condition: {kind: 'compute', expr: {op: 'eq', args: [{ref: {path: 'ok'}}, {literal: true}]}},
        },
        {
            kind: 'output',
            name: 'final',
            expr: {kind: 'compute', expr: {op: 'not', args: [{ref: {path: 'ok'}}]}},
        },
    ]);
});

test('compute parser supports quoted strings numbers booleans and null', () => {
    const program = parseDsl('let ok = compute and(eq("ready", "ready"), not(eq(3, null)))');
    assert.deepEqual(program.body[0], {
        kind: 'let',
        name: 'ok',
        expr: {
            kind: 'compute',
            expr: {
                op: 'and',
                args: [
                    {op: 'eq', args: [{literal: 'ready'}, {literal: 'ready'}]},
                    {op: 'not', args: [{op: 'eq', args: [{literal: 3}, {literal: null}]}]},
                ],
            },
        },
    });
});

test('compute expressions are accepted in if and for expression positions', () => {
    const program = parseDsl(`
        if compute eq(input.enabled, true):
          output yes = input.enabled
        for item in compute first(input.groups):
          output current = item
    `);
    assert.equal(program.body[0].kind, 'if');
    assert.deepEqual(program.body[0].condition, {
        kind: 'compute',
        expr: {op: 'eq', args: [{ref: {path: 'input.enabled'}}, {literal: true}]},
    });
    assert.equal(program.body[1].kind, 'for');
    assert.deepEqual(program.body[1].iterable, {
        kind: 'compute',
        expr: {op: 'first', args: [{ref: {path: 'input.groups'}}]},
    });
});

test('compute parser rejects unsupported operators and malformed arguments', () => {
    assert.throws(() => parseDsl('let x = compute add(1, 2)'), DslParseError);
    assert.throws(() => parseDsl('let x = compute eq(1,)'), DslParseError);
});
