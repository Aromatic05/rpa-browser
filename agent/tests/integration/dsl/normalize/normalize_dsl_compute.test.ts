import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDsl} from '../../../../src/program/dsl/normalize';
import type {DslProgram} from '../../../../src/program/dsl/ast';

test('normalizeDsl prefixes compute refs and ensure refs without touching rooted values', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'ok',
                expr: {
                    kind: 'compute',
                    expr: {
                        op: 'and',
                        args: [
                            {op: 'exists', args: [{ref: {path: 'rows'}}]},
                            {op: 'eq', args: [{ref: {path: 'count'}}, {ref: {path: 'input.expected'}}]},
                        ],
                    },
                },
            },
            {kind: 'ensure', condition: {kind: 'ref', ref: 'ok'}},
        ],
    };

    assert.deepEqual(normalizeDsl(program).body, [
        {
            kind: 'let',
            name: 'ok',
            expr: {
                kind: 'compute',
                expr: {
                    op: 'and',
                    args: [
                        {op: 'exists', args: [{ref: {path: 'vars.rows'}}]},
                        {op: 'eq', args: [{ref: {path: 'vars.count'}}, {ref: {path: 'input.expected'}}]},
                    ],
                },
            },
        },
        {kind: 'ensure', condition: {kind: 'ref', ref: 'vars.ok'}},
    ]);
});
