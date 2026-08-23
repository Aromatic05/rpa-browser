import test from 'node:test';
import assert from 'node:assert/strict';
import type { DslProgram } from '../../../../src/dsl/ast';
import { normalizeDsl } from '../../../../src/dsl/normalize';
import { validateDsl } from '../../../../src/dsl/validate';

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

test('validateDsl reports duplicate vars inside if body and keeps branch vars local', () => {
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
    assert.deepEqual(branchLocalDiagnostics.map((item) => item.code), ['ERR_DSL_VAR_NOT_DEFINED']);
});

test('validateDsl does not definitely assign loop or branch-only variables', () => {
    const diagnostics = validateDsl(normalizeDsl({
        body: [
            {
                kind: 'for',
                item: 'row',
                iterable: { kind: 'ref', ref: 'input.rows' },
                body: [{ kind: 'let', name: 'fromLoop', expr: { kind: 'ref', ref: 'row' } }],
            },
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'input.enabled' },
                then: [{ kind: 'let', name: 'fromThen', expr: { kind: 'ref', ref: 'input.value' } }],
                else: [{ kind: 'let', name: 'fromElse', expr: { kind: 'ref', ref: 'input.value' } }],
            },
            { kind: 'act', action: 'click', target: { kind: 'ref', ref: 'fromLoop' } },
            { kind: 'act', action: 'click', target: { kind: 'ref', ref: 'fromThen' } },
            { kind: 'act', action: 'click', target: { kind: 'ref', ref: 'fromElse' } },
        ],
    }));

    assert.deepEqual(diagnostics.map((item) => item.code), [
        'ERR_DSL_VAR_NOT_DEFINED',
        'ERR_DSL_VAR_NOT_DEFINED',
        'ERR_DSL_VAR_NOT_DEFINED',
    ]);
});

test('validateDsl promotes a variable assigned by both if branches', () => {
    const diagnostics = validateDsl(normalizeDsl({
        body: [
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'input.enabled' },
                then: [{ kind: 'let', name: 'selected', expr: { kind: 'ref', ref: 'input.primary' } }],
                else: [{ kind: 'let', name: 'selected', expr: { kind: 'ref', ref: 'input.fallback' } }],
            },
            { kind: 'act', action: 'click', target: { kind: 'ref', ref: 'selected' } },
        ],
    }));

    assert.deepEqual(diagnostics, []);
});

test('validateDsl promotes a checkpoint result bound by both if branches', () => {
    const diagnostics = validateDsl(normalizeDsl({
        body: [
            {
                kind: 'if',
                condition: {kind: 'ref', ref: 'input.enabled'},
                then: [{kind: 'checkpoint', id: 'primary', bind: 'selected'}],
                else: [{kind: 'checkpoint', id: 'fallback', bind: 'selected'}],
            },
            {kind: 'act', action: 'click', target: {kind: 'ref', ref: 'selected.target'}},
        ],
    }));

    assert.deepEqual(diagnostics, []);
});
