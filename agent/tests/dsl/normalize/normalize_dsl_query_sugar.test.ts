import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { normalizeDsl } from '../../../src/dsl/normalize';

test('normalizeDsl expands table query sugar', () => {
    const normalized = normalizeDsl(
        parseDsl(`
            let rows = query table "order.list" current_rows
            let count = query table "order.list" row_count
            let hasNext = query table "order.list" has_next_page
            let next = query table "order.list" next_page_target
        `),
    );

    assert.deepEqual((normalized.body[0] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.list',
        payload: 'table.current_rows',
    });
    assert.deepEqual((normalized.body[1] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.list',
        payload: 'table.row_count',
    });
    assert.deepEqual((normalized.body[2] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.list',
        payload: 'table.hasNextPage',
    });
    assert.deepEqual((normalized.body[3] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.list',
        payload: 'table.nextPageTarget',
    });
});

test('normalizeDsl expands form query sugar and removes query_sugar nodes', () => {
    const normalized = normalizeDsl(
        parseDsl(`
            let fields = query form "order.form" fields
            let actions = query form "order.form" actions
        `),
    );

    assert.deepEqual((normalized.body[0] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.form',
        payload: 'form.fields',
    });
    assert.deepEqual((normalized.body[1] as any).expr, {
        kind: 'query',
        op: 'entity',
        businessTag: 'order.form',
        payload: 'form.actions',
    });
    assert.equal(
        normalized.body.some((stmt) => stmt.kind === 'let' && (stmt as any).expr.kind === 'query_sugar'),
        false,
    );
});
