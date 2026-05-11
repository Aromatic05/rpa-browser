import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { DslParseError } from '../../../src/dsl/diagnostics/errors';

test('parseDsl parses if block', () => {
    const program = parseDsl(`
if input.enabled:
  click submit
    `);

    assert.deepEqual(program.body[0], {
        kind: 'if',
        condition: { kind: 'ref', ref: 'input.enabled' },
        then: [
            {
                kind: 'act',
                action: 'click',
                target: { kind: 'ref', ref: 'submit' },
            },
        ],
        else: undefined,
    });
});

test('parseDsl parses if else block', () => {
    const program = parseDsl(`
if input.enabled:
  click submit
else:
  click cancel
    `);

    assert.equal(program.body[0].kind, 'if');
    assert.deepEqual(program.body[0].else, [
        {
            kind: 'act',
            action: 'click',
            target: { kind: 'ref', ref: 'cancel' },
        },
    ]);
});

test('parseDsl parses for block and nested if', () => {
    const program = parseDsl(`
for row in rows:
  if row.enabled:
    fill buyer with row.name
    `);

    assert.equal(program.body[0].kind, 'for');
    assert.deepEqual(program.body[0].iterable, { kind: 'ref', ref: 'rows' });
    assert.equal(program.body[0].body[0].kind, 'if');
});

test('parseDsl throws on invalid indentation and else without if', () => {
    assert.throws(
        () =>
            parseDsl(`
if input.enabled:
   click submit
            `),
        (error: unknown) => error instanceof DslParseError,
    );

    assert.throws(
        () =>
            parseDsl(`
else:
  click cancel
            `),
        (error: unknown) => error instanceof DslParseError,
    );
});
