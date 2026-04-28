import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { DslParseError } from '../../../src/dsl/diagnostics/errors';

test('parseDsl parses table query sugar ops', () => {
    const program = parseDsl(`
        let rows = query table "order.list" current_rows
        let count = query table "order.list" row_count
        let hasNext = query table "order.list" has_next_page
        let next = query table "order.list" next_page_target
    `);

    assert.deepEqual(program.body.map((stmt) => (stmt as any).expr), [
        { kind: 'query_sugar', target: 'table', businessTag: 'order.list', op: 'current_rows' },
        { kind: 'query_sugar', target: 'table', businessTag: 'order.list', op: 'row_count' },
        { kind: 'query_sugar', target: 'table', businessTag: 'order.list', op: 'has_next_page' },
        { kind: 'query_sugar', target: 'table', businessTag: 'order.list', op: 'next_page_target' },
    ]);
});

test('parseDsl parses form query sugar ops', () => {
    const program = parseDsl(`
        let fields = query form "order.form" fields
        let actions = query form "order.form" actions
    `);
    assert.deepEqual(program.body.map((stmt) => (stmt as any).expr), [
        { kind: 'query_sugar', target: 'form', businessTag: 'order.form', op: 'fields' },
        { kind: 'query_sugar', target: 'form', businessTag: 'order.form', op: 'actions' },
    ]);
});

test('parseDsl throws on unknown table op', () => {
    assert.throws(
        () => parseDsl(`let x = query table "order.list" bad_op`),
        (error: unknown) => error instanceof DslParseError,
    );
});

test('parseDsl throws on unknown form op', () => {
    assert.throws(
        () => parseDsl(`let x = query form "order.form" bad_op`),
        (error: unknown) => error instanceof DslParseError,
    );
});
