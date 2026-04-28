import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { normalizeDsl } from '../../../src/dsl/normalize';

test('normalizeDsl expands fill form into let query and fill act', () => {
    const normalized = normalizeDsl(
        parseDsl(`
            fill form "order.form" field "buyer" with input.user.name
        `),
    );

    assert.equal(normalized.body.length, 2);
    assert.deepEqual(normalized.body[0], {
        kind: 'let',
        name: '__dsl_form_target_1',
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
    assert.deepEqual(normalized.body[1], {
        kind: 'act',
        action: 'fill',
        target: { kind: 'ref', ref: 'vars.__dsl_form_target_1' },
        value: { kind: 'ref', ref: 'input.user.name' },
    });
});

test('normalizeDsl expands click form into let query and click act', () => {
    const normalized = normalizeDsl(
        parseDsl(`
            click form "order.form" action "submit"
        `),
    );

    assert.equal(normalized.body.length, 2);
    assert.deepEqual(normalized.body[0], {
        kind: 'let',
        name: '__dsl_form_target_1',
        expr: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            payload: {
                kind: 'form.action',
                actionIntent: 'submit',
            },
        },
    });
    assert.deepEqual(normalized.body[1], {
        kind: 'act',
        action: 'click',
        target: { kind: 'ref', ref: 'vars.__dsl_form_target_1' },
    });
});

test('normalizeDsl removes form_act and allocates stable temp names', () => {
    const normalized = normalizeDsl(
        parseDsl(`
            fill form "order.form" field "buyer" with input.user.name
            click form "order.form" action "submit"
        `),
    );

    assert.equal(normalized.body.some((stmt) => stmt.kind === 'form_act'), false);
    assert.equal(normalized.body[0].kind === 'let' ? normalized.body[0].name : '', '__dsl_form_target_1');
    assert.equal(normalized.body[2].kind === 'let' ? normalized.body[2].name : '', '__dsl_form_target_2');
});
