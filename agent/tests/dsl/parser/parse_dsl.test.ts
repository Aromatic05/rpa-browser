import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { DslParseError } from '../../../src/dsl/diagnostics/errors';

test('parseDsl parses use checkpoint and checkpoint input refs', () => {
    const program = parseDsl(`
        use checkpoint "ensure_logged_in" with {
          username: input.username
        }
    `);

    assert.equal(program.body.length, 1);
    assert.deepEqual(program.body[0], {
        kind: 'checkpoint',
        id: 'ensure_logged_in',
        input: {
            username: { kind: 'ref', ref: 'input.username' },
        },
    });
});

test('parseDsl parses let query entity.target fill and click', () => {
    const program = parseDsl(`
        let buyer = query entity.target "order.form" {
          kind: "form.field"
          fieldKey: "buyer"
        }

        fill buyer with input.user.name
        click buyer
    `);

    assert.equal(program.body.length, 3);
    assert.deepEqual(program.body[0], {
        kind: 'let',
        name: 'buyer',
        expr: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            payload: {
                kind: 'form.field',
                fieldKey: 'buyer',
            },
        },
    });
    assert.deepEqual(program.body[1], {
        kind: 'act',
        action: 'fill',
        target: { kind: 'ref', ref: 'buyer' },
        value: { kind: 'ref', ref: 'input.user.name' },
    });
    assert.deepEqual(program.body[2], {
        kind: 'act',
        action: 'click',
        target: { kind: 'ref', ref: 'buyer' },
    });
});

test('parseDsl throws DslParseError on invalid object literals', () => {
    assert.throws(
        () =>
            parseDsl(`
                let buyer = query entity.target "order.form" {
                  kind: "form.field
                  fieldKey:
                }
            `),
        (error: unknown) => error instanceof DslParseError,
    );
});

test('parseDsl parses type/select/wait/snapshot actions', () => {
    const program = parseDsl(`
        type buyer with input.text
        select buyer with input.value
        wait 500
        snapshot
    `);

    assert.deepEqual(program.body, [
        {
            kind: 'act',
            action: 'type',
            target: { kind: 'ref', ref: 'buyer' },
            value: { kind: 'ref', ref: 'input.text' },
        },
        {
            kind: 'act',
            action: 'select',
            target: { kind: 'ref', ref: 'buyer' },
            value: { kind: 'ref', ref: 'input.value' },
        },
        {
            kind: 'act',
            action: 'wait',
            durationMs: 500,
        },
        {
            kind: 'act',
            action: 'snapshot',
        },
    ]);
});
