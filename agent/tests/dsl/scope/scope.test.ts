import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslScope, getDslValue, setDslValue } from '../../../src/dsl/runtime';

test('DSL scope reads and writes nested refs', () => {
    const scope = createDslScope({ user: { name: 'alice' } });
    setDslValue(scope, 'vars.buyer', { nodeId: 'node-1' });
    setDslValue(scope, 'output.session.loggedIn', true);

    assert.deepEqual(getDslValue(scope, 'vars.buyer'), { nodeId: 'node-1' });
    assert.equal(getDslValue(scope, 'input.user.name'), 'alice');
    assert.equal(getDslValue(scope, 'output.session.loggedIn'), true);
});
