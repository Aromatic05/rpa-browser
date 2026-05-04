import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDsl } from '../../../src/dsl/validate';
import type { DslProgram } from '../../../src/dsl/ast';

test('validateDsl reports ERR_DSL_NOT_NORMALIZED for querySugar', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'rows',
                expr: {
                    kind: 'querySugar',
                    target: 'table',
                    businessTag: 'order.list',
                    op: 'currentRows',
                },
            },
        ],
    };

    const diagnostics = validateDsl(program);
    assert.equal(diagnostics.some((item) => item.code === 'ERR_DSL_NOT_NORMALIZED'), true);
});
