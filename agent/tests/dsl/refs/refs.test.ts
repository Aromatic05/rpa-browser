import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDslValue, createDslScope, setDslValue } from '../../../src/dsl/runtime';

test('resolveDslValue resolves structured refs recursively', () => {
    const scope = createDslScope({ user: { name: 'alice' } });
    setDslValue(scope, 'vars.buyer', { nodeId: 'node-1' });

    const resolved = resolveDslValue(
        {
            target: { kind: 'ref', ref: 'vars.buyer' },
            value: { kind: 'ref', ref: 'input.user.name' },
        },
        scope,
    );

    assert.deepEqual(resolved, {
        target: { nodeId: 'node-1' },
        value: 'alice',
    });
});
