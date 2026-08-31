import test from 'node:test';
import assert from 'node:assert/strict';
import {validateDsl} from '../../../../src/program/dsl/validate';
import type {DslProgram} from '../../../../src/program/dsl/ast';

test('validateDsl validates refs inside compute and ensure', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'ok',
                expr: {kind: 'compute', expr: {op: 'eq', args: [{ref: {path: 'vars.missing'}}, {literal: 1}]}},
            },
            {kind: 'ensure', condition: {kind: 'ref', ref: 'vars.otherMissing'}},
        ],
    };
    assert.deepEqual(validateDsl(program).map((item) => item.code), [
        'ERR_DSL_VAR_NOT_DEFINED',
        'ERR_DSL_VAR_NOT_DEFINED',
    ]);
});

test('validateDsl rejects compute arity before runtime', () => {
    const program: DslProgram = {
        body: [{
            kind: 'let',
            name: 'bad',
            expr: {kind: 'compute', expr: {op: 'not', args: [{literal: true}, {literal: false}]}},
        }],
    };
    const diagnostics = validateDsl(program);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'ERR_DSL_BAD_COMPUTE_ARITY');
});
