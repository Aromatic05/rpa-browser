import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsl } from '../../../src/dsl/normalize';
import type { DslProgram } from '../../../src/dsl/ast';

test('normalizeDsl prefixes vars refs and keeps input/output refs unchanged', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'act',
                action: 'fill',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'input.user.name' },
            },
            {
                kind: 'checkpoint',
                id: 'ensure_logged_in',
                input: {
                    username: { kind: 'ref', ref: 'user.name' },
                    session: { kind: 'ref', ref: 'output.sessionId' },
                },
            },
        ],
    };

    const normalized = normalizeDsl(program);
    assert.deepEqual(normalized.body[0], {
        kind: 'act',
        action: 'fill',
        target: { kind: 'ref', ref: 'vars.buyer' },
        value: { kind: 'ref', ref: 'input.user.name' },
    });
    assert.deepEqual(normalized.body[1], {
        kind: 'checkpoint',
        id: 'ensure_logged_in',
        input: {
            username: { kind: 'ref', ref: 'vars.user.name' },
            session: { kind: 'ref', ref: 'output.sessionId' },
        },
    });
});

test('normalizeDsl recurses through if and for bodies', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'if',
                condition: { kind: 'ref', ref: 'buyer' },
                then: [
                    {
                        kind: 'act',
                        action: 'click',
                        target: { kind: 'ref', ref: 'submitButton' },
                    },
                ],
                else: [
                    {
                        kind: 'checkpoint',
                        id: 'cp-1',
                        input: {
                            fallback: { kind: 'ref', ref: 'buyer' },
                        },
                    },
                ],
            },
            {
                kind: 'for',
                item: 'buyer',
                iterable: { kind: 'ref', ref: 'buyers' },
                body: [
                    {
                        kind: 'act',
                        action: 'click',
                        target: { kind: 'ref', ref: 'buyer' },
                    },
                ],
            },
        ],
    };

    const normalized = normalizeDsl(program);
    const ifStmt = normalized.body[0];
    const forStmt = normalized.body[1];

    assert.equal(ifStmt.kind, 'if');
    assert.deepEqual(ifStmt.condition, { kind: 'ref', ref: 'vars.buyer' });
    assert.equal(ifStmt.then[0].kind, 'act');
    assert.equal(ifStmt.then[0].action, 'click');
    assert.deepEqual(ifStmt.then[0].target, { kind: 'ref', ref: 'vars.submitButton' });
    assert.deepEqual(ifStmt.else?.[0], {
        kind: 'checkpoint',
        id: 'cp-1',
        input: {
            fallback: { kind: 'ref', ref: 'vars.buyer' },
        },
    });

    assert.equal(forStmt.kind, 'for');
    assert.deepEqual(forStmt.iterable, { kind: 'ref', ref: 'vars.buyers' });
    assert.equal(forStmt.body[0].kind, 'act');
    assert.equal(forStmt.body[0].action, 'click');
    assert.deepEqual(forStmt.body[0].target, { kind: 'ref', ref: 'vars.buyer' });
});

test('normalizeDsl keeps wait duration and normalizes type/select refs', () => {
    const program: DslProgram = {
        body: [
            {
                kind: 'act',
                action: 'type',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'text' },
            },
            {
                kind: 'act',
                action: 'select',
                target: { kind: 'ref', ref: 'buyer' },
                value: { kind: 'ref', ref: 'input.value' },
            },
            {
                kind: 'act',
                action: 'wait',
                durationMs: 100,
            },
        ],
    };

    const normalized = normalizeDsl(program);
    assert.deepEqual(normalized.body[0], {
        kind: 'act',
        action: 'type',
        target: { kind: 'ref', ref: 'vars.buyer' },
        value: { kind: 'ref', ref: 'vars.text' },
    });
    assert.deepEqual(normalized.body[1], {
        kind: 'act',
        action: 'select',
        target: { kind: 'ref', ref: 'vars.buyer' },
        value: { kind: 'ref', ref: 'input.value' },
    });
    assert.deepEqual(normalized.body[2], {
        kind: 'act',
        action: 'wait',
        durationMs: 100,
    });
});
