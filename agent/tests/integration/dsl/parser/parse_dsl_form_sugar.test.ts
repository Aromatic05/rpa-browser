import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../../src/dsl/parser';
import { DslParseError } from '../../../../src/dsl/diagnostics/errors';

test('parseDsl parses fill form field syntax sugar', () => {
    const program = parseDsl(`
        fill form "order.form" field "buyer" with input.user.name
    `);

    assert.deepEqual(program.body[0], {
        kind: 'form_act',
        action: 'fill',
        businessTag: 'order.form',
        target: {
            kind: 'field',
            fieldKey: 'buyer',
        },
        value: { kind: 'ref', ref: 'input.user.name' },
    });
});

test('parseDsl parses click form action syntax sugar', () => {
    const program = parseDsl(`
        click form "order.form" action "submit"
    `);

    assert.deepEqual(program.body[0], {
        kind: 'form_act',
        action: 'click',
        businessTag: 'order.form',
        target: {
            kind: 'action',
            actionIntent: 'submit',
        },
    });
});

test('parseDsl throws when fill form misses with clause', () => {
    assert.throws(
        () =>
            parseDsl(`
                fill form "order.form" field "buyer"
            `),
        (error: unknown) => error instanceof DslParseError,
    );
});

test('parseDsl throws when click form has with clause', () => {
    assert.throws(
        () =>
            parseDsl(`
                click form "order.form" action "submit" with input.user.name
            `),
        (error: unknown) => error instanceof DslParseError,
    );
});

test('parseDsl parses table filter and module action syntax sugar', () => {
    const program = parseDsl(`
        fill table "orders.table" filter "订单编号" with input.orderNo
        click table "orders.table" action "search"
    `);

    assert.deepEqual(program.body, [
        {
            kind: 'table_act',
            action: 'fill',
            businessTag: 'orders.table',
            target: {kind: 'filter', fieldKey: '订单编号'},
            value: {kind: 'ref', ref: 'input.orderNo'},
        },
        {
            kind: 'table_act',
            action: 'click',
            businessTag: 'orders.table',
            target: {kind: 'action', actionIntent: 'search'},
        },
    ]);
});
