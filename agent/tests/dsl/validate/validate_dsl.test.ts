import test from 'node:test';
import assert from 'node:assert/strict';
import type { DslProgram } from '../../../src/dsl/ast';
import { normalizeDsl } from '../../../src/dsl/normalize';
import { validateDsl } from '../../../src/dsl/validate';

test('validateDsl reports duplicate variables', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'buyer',
                expr: {
                    kind: 'query',
                    op: 'entity.target',
                    businessTag: 'order.form',
                    payload: { kind: 'form.field', fieldKey: 'buyer' },
                },
            },
            {
                kind: 'let',
                name: 'buyer',
                expr: {
                    kind: 'query',
                    op: 'entity.target',
                    businessTag: 'order.form',
                    payload: { kind: 'form.field', fieldKey: 'buyer2' },
                },
            },
        ],
    };

    const diagnostics = validateDsl(normalizeDsl(program));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'ERR_DSL_VAR_REDEFINED');
});

test('validateDsl reports undefined vars and accepts input refs', () => {
    const missingVarProgram: DslProgram = {
        body: [
            {
                kind: 'act',
                action: 'fill',
                target: { kind: 'ref', ref: 'vars.buyer' },
                value: { kind: 'ref', ref: 'input.user.name' },
            },
        ],
    };
    const okProgram: DslProgram = {
        body: [
            {
                kind: 'checkpoint',
                id: 'cp-1',
                input: {
                    username: { kind: 'ref', ref: 'input.username' },
                },
            },
        ],
    };

    const missingVarDiagnostics = validateDsl(normalizeDsl(missingVarProgram));
    const okDiagnostics = validateDsl(normalizeDsl(okProgram));

    assert.equal(missingVarDiagnostics.length, 1);
    assert.equal(missingVarDiagnostics[0].code, 'ERR_DSL_VAR_NOT_DEFINED');
    assert.deepEqual(okDiagnostics, []);
});

test('validateDsl enforces act argument rules', () => {
    const fillWithoutValue: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'buyer',
                expr: {
                    kind: 'query',
                    op: 'entity.target',
                    businessTag: 'order.form',
                    payload: { kind: 'form.field', fieldKey: 'buyer' },
                },
            },
            {
                kind: 'act',
                action: 'fill',
                target: { kind: 'ref', ref: 'buyer' },
            },
        ],
    };
    const clickWithValue: DslProgram = {
        body: [
            {
                kind: 'let',
                name: 'buyer',
                expr: {
                    kind: 'query',
                    op: 'entity.target',
                    businessTag: 'order.form',
                    payload: { kind: 'form.field', fieldKey: 'buyer' },
                },
            },
            {
                kind: 'act',
                action: 'click',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'input.user.name' },
            },
        ],
    };

    const fillDiagnostics = validateDsl(normalizeDsl(fillWithoutValue));
    const clickDiagnostics = validateDsl(normalizeDsl(clickWithValue));

    assert.equal(fillDiagnostics.some((item) => item.code === 'ERR_DSL_BAD_ACT_ARGS'), true);
    assert.equal(clickDiagnostics.some((item) => item.code === 'ERR_DSL_BAD_ACT_ARGS'), true);
});

test('validateDsl requires checkpoint input refs', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'checkpoint',
                id: 'cp-1',
                input: {
                    username: { kind: 'ref', ref: 'input.username' },
                    raw: { kind: 'query', op: 'entity', businessTag: 'order.form', payload: 'form.fields' },
                },
            },
        ],
    };

    const diagnostics = validateDsl(normalizeDsl(program));
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'ERR_DSL_BAD_CHECKPOINT_INPUT');
});
