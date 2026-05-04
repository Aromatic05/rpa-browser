import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDsl } from '../../../src/dsl/parser';
import { DslParseError } from '../../../src/dsl/diagnostics/errors';

test('parseDsl parses table query sugar ops', () => {
    const program = parseDsl(`
        let rows = query table "order.list" currentRows
        let count = query table "order.list" rowCount
        let hasNext = query table "order.list" hasNextPage
        let next = query table "order.list" nextPageTarget
    `);

    assert.deepEqual(program.body.map((stmt) => (stmt as any).expr), [
        { kind: 'querySugar', target: 'table', businessTag: 'order.list', op: 'currentRows' },
        { kind: 'querySugar', target: 'table', businessTag: 'order.list', op: 'rowCount' },
        { kind: 'querySugar', target: 'table', businessTag: 'order.list', op: 'hasNextPage' },
        { kind: 'querySugar', target: 'table', businessTag: 'order.list', op: 'nextPageTarget' },
    ]);
});

test('parseDsl parses form query sugar ops', () => {
    const program = parseDsl(`
        let fields = query form "order.form" fields
        let actions = query form "order.form" actions
    `);
    assert.deepEqual(program.body.map((stmt) => (stmt as any).expr), [
        { kind: 'querySugar', target: 'form', businessTag: 'order.form', op: 'fields' },
        { kind: 'querySugar', target: 'form', businessTag: 'order.form', op: 'actions' },
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
