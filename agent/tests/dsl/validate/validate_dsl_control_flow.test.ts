import test from 'node:test';
import assert from 'node:assert/strict';
import type { DslProgram } from '../../../src/dsl/ast';
import { normalizeDsl } from '../../../src/dsl/normalize';
import { validateDsl } from '../../../src/dsl/validate';

test('validateDsl allows for item refs inside loop body', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'rows',
                expr: { kind: 'ref', ref: 'input.rows' },
            },
            {
                kind: 'for',
                item: 'row',
                iterable: { kind: 'ref', ref: 'rows' },
                body: [
                    {
                        kind: 'act',
                        action: 'fill',
                        target: { kind: 'ref', ref: 'buyer' },
                        value: { kind: 'ref', ref: 'row.name' },
                    },
                ],
            },
        ],
    };

    const diagnostics = validateDsl(
        normalizeDsl({
            body: [
                {
                    kind: 'let',
                    name: 'buyer',
                    expr: { kind: 'ref', ref: 'input.buyer' },
                },
                ...program.body,
            ],
        }),
    );
    assert.deepEqual(diagnostics, []);
});

test('validateDsl reports undefined refs in for iterable and if condition', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'for',
                item: 'row',
                iterable: { kind: 'ref', ref: 'rows' },
                body: [],
            },
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'enabled' },
                then: [],
            },
        ],
    };

    const diagnostics = validateDsl(normalizeDsl(program));
    assert.equal(diagnostics.length, 2);
    assert.equal(diagnostics[0].code, 'ERR_DSL_VAR_NOT_DEFINED');
    assert.equal(diagnostics[1].code, 'ERR_DSL_VAR_NOT_DEFINED');
});

test('validateDsl reports duplicate vars inside if body and keeps branch scope local', () => {
    const duplicateProgram: DslProgram = {
        body: [
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'input.enabled' },
                then: [
                    { kind: 'let', name: 'buyer', expr: { kind: 'ref', ref: 'input.a' } },
                    { kind: 'let', name: 'buyer', expr: { kind: 'ref', ref: 'input.b' } },
                ],
            },
        ],
    };
    const branchLocalProgram: DslProgram = {
        body: [
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'input.enabled' },
                then: [{ kind: 'let', name: 'buyer', expr: { kind: 'ref', ref: 'input.a' } }],
            },
            {
                kind: 'act',
                action: 'click',
                target: { kind: 'ref', ref: 'buyer' },
            },
        ],
    };

    const duplicateDiagnostics = validateDsl(normalizeDsl(duplicateProgram));
    const branchLocalDiagnostics = validateDsl(normalizeDsl(branchLocalProgram));

    assert.equal(duplicateDiagnostics.some((item) => item.code === 'ERR_DSL_VAR_REDEFINED'), true);
    assert.equal(branchLocalDiagnostics.some((item) => item.code === 'ERR_DSL_VAR_NOT_DEFINED'), true);
});
