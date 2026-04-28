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

test('parseDsl parses reserved if and for nodes', () => {
    const program = parseDsl(`
        if input.enabled
        for buyer in input.buyers
    `);

    assert.equal(program.body.length, 2);
    assert.equal(program.body[0].kind, 'if');
    assert.equal(program.body[1].kind, 'for');
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
