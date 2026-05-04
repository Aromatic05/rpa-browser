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

test('validateDsl allows wait/snapshot and validates type/select args', () => {
    const okProgram: DslProgram = {
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
            { kind: 'act', action: 'wait', durationMs: 10 },
            { kind: 'act', action: 'snapshot' },
            {
                kind: 'act',
                action: 'type',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'input.text' },
            },
            {
                kind: 'act',
                action: 'select',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'input.value' },
            },
        ],
    };
    const badProgram: DslProgram = {
        body: [
            {
                kind: 'act',
                action: 'type',
                target: { kind: 'ref', ref: 'buyer' },
            },
        ],
    };

    assert.deepEqual(validateDsl(normalizeDsl(okProgram)), []);
    assert.equal(validateDsl(normalizeDsl(badProgram)).some((item) => item.code === 'ERR_DSL_BAD_ACT_ARGS'), true);
});

test('validateDsl rejects non-normalized form_act statements', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'form_act',
                action: 'click',
                businessTag: 'order.form',
                target: { kind: 'action', actionIntent: 'submit' },
            },
        ],
    };
    const diagnostics = validateDsl(program);
    assert.equal(diagnostics.some((item) => item.code === 'ERR_DSL_NOT_NORMALIZED'), true);
});
