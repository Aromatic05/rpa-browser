import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../../src/dsl/parser';
import { normalizeDsl } from '../../../../src/dsl/normalize';

test('normalizeDsl expands fill form into one linked entity action', () => {
    const normalized = normalizeDsl(parseDsl(`
        fill form "order.form" field "buyer" with input.user.name
    `));

    assert.deepEqual(normalized.body, [{
        kind: 'linked_entity_act',
        action: 'fill',
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            payload: {kind: 'form.field', fieldKey: 'buyer'},
        },
        value: {kind: 'ref', ref: 'input.user.name'},
    }]);
});

test('normalizeDsl expands click form without generated temporary variables', () => {
    const normalized = normalizeDsl(parseDsl(`
        click form "order.form" action "submit"
    `));

    assert.deepEqual(normalized.body, [{
        kind: 'linked_entity_act',
        action: 'click',
        targetQuery: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.form',
            payload: {kind: 'form.action', actionIntent: 'submit'},
        },
    }]);
});

test('normalizeDsl removes form and table sugar without leaking implementation variables', () => {
    const normalized = normalizeDsl(parseDsl(`
        fill form "order.form" field "buyer" with input.user.name
        click form "order.form" action "submit"
        fill table "orders.table" filter "orderNo" with input.orderNo
        click table "orders.table" action "search"
    `));

    assert.equal(normalized.body.every((stmt) => stmt.kind === 'linked_entity_act'), true);
    assert.equal(JSON.stringify(normalized).includes('dslFormTarget'), false);
    assert.equal(JSON.stringify(normalized).includes('dslTableTarget'), false);
});

test('normalizeDsl expands table filter and module action syntax sugar', () => {
    const normalized = normalizeDsl(parseDsl(`
        fill table "orders.table" filter "订单编号" with input.orderNo
        click table "orders.table" action "search"
    `));

    assert.deepEqual(normalized.body, [
        {
            kind: 'linked_entity_act',
            action: 'fill',
            targetQuery: {
                kind: 'query',
                op: 'entity.target',
                businessTag: 'orders.table',
                payload: {kind: 'table.filter', fieldKey: '订单编号'},
            },
            value: {kind: 'ref', ref: 'input.orderNo'},
        },
        {
            kind: 'linked_entity_act',
            action: 'click',
            targetQuery: {
                kind: 'query',
                op: 'entity.target',
                businessTag: 'orders.table',
                payload: {kind: 'table.module_action', actionIntent: 'search'},
            },
        },
    ]);
});
