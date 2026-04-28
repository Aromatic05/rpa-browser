import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDsl } from '../../../src/dsl/validate';
import type { DslProgram } from '../../../src/dsl/ast';

test('validateDsl reports ERR_DSL_NOT_NORMALIZED for query_sugar', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'rows',
                expr: {
                    kind: 'query_sugar',
                    target: 'table',
                    businessTag: 'order.list',
                    op: 'current_rows',
                },
            },
        ],
    };

    const diagnostics = validateDsl(program);
    assert.equal(diagnostics.some((item) => item.code === 'ERR_DSL_NOT_NORMALIZED'), true);
});
