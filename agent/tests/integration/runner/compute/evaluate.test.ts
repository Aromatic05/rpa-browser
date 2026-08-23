import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateComputeExpression} from '../../../../src/runner/compute/evaluate';

test('compute evaluator is pure over an explicit scope', () => {
    const scope = {
        local: {
            rows: [{id: 'a'}, {id: 'b'}],
        },
    };
    const value = evaluateComputeExpression({
        op: 'eq',
        args: [
            {op: 'len', args: [{ref: {path: 'local.rows'}}]},
            {literal: 2},
        ],
    }, scope);

    assert.equal(value, true);
    assert.deepEqual(scope.local.rows, [{id: 'a'}, {id: 'b'}]);
});

test('compute evaluator rejects missing refs without runtime dependencies', () => {
    assert.throws(
        () => evaluateComputeExpression({
            op: 'exists',
            args: [{ref: {path: 'local.missing'}}],
        }, {local: {}}),
        /missing compute ref: local\.missing/,
    );
});
