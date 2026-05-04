import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslScope, resolveDslValue, setDslValue } from '../../../src/dsl/runtime';
import { DslRuntimeError } from '../../../src/dsl/diagnostics/errors';

test('resolveDslValue resolves ref nested objects and arrays', () => {
    const scope = createDslScope({ user: { name: 'alice' }, ids: ['a', 'b'] });
    setDslValue(scope, 'vars.buyer', { nodeId: 'node-1' });

    assert.deepEqual(resolveDslValue({ kind: 'ref', ref: 'vars.buyer' }, scope), { nodeId: 'node-1' });
    assert.deepEqual(
        resolveDslValue(
            {
                target: { kind: 'ref', ref: 'vars.buyer' },
                values: [{ kind: 'ref', ref: 'input.user.name' }, 1, true],
            },
            scope,
        ),
        {
            target: { nodeId: 'node-1' },
            values: ['alice', 1, true],
        },
    );
    assert.deepEqual(resolveDslValue([{ kind: 'ref', ref: 'input.user.name' }, 'raw'], scope), ['alice', 'raw']);
});

test('resolveDslValue keeps primitives untouched and throws on missing refs', () => {
    const scope = createDslScope();
    assert.equal(resolveDslValue('plain', scope), 'plain');
    assert.equal(resolveDslValue(42, scope), 42);
    assert.throws(
        () => resolveDslValue({ kind: 'ref', ref: 'vars.missing' }, scope),
        (error: unknown) => error instanceof DslRuntimeError && error.message === 'DSL ref not found: vars.missing',
    );
});
