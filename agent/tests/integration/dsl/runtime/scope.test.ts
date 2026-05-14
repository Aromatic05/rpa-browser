import test from 'node:test';
import assert from 'node:assert/strict';
import { createDslScope, getDslValue, setDslValue } from '../../../src/dsl/runtime';
import { DslRuntimeError } from '../../../src/dsl/diagnostics/errors';

test('createDslScope initializes input vars and output containers', () => {
    const scope = createDslScope({ user: { name: 'alice' } });
    assert.deepEqual(scope, {
        input: { user: { name: 'alice' } },
        vars: {},
        output: {},
    });
});

test('getDslValue reads input vars and output refs', () => {
    const scope = createDslScope({ user: { name: 'alice' } });
    setDslValue(scope, 'vars.buyer.nodeId', 'node-1');
    setDslValue(scope, 'output.session.loggedIn', true);

    assert.equal(getDslValue(scope, 'input.user.name'), 'alice');
    assert.equal(getDslValue(scope, 'vars.buyer.nodeId'), 'node-1');
    assert.equal(getDslValue(scope, 'output.session.loggedIn'), true);
});

test('setDslValue creates intermediate objects automatically', () => {
    const scope = createDslScope();
    setDslValue(scope, 'vars.form.buyer.nodeId', 'node-1');
    assert.deepEqual(scope.vars, {
        form: {
            buyer: {
                nodeId: 'node-1',
            },
        },
    });
});

test('scope throws for invalid root missing refs and root assignment', () => {
    const scope = createDslScope();

    assert.throws(
        () => getDslValue(scope, 'session.user'),
        (error: unknown) => error instanceof DslRuntimeError && error.message === 'invalid DSL ref root: session.user',
    );
    assert.throws(
        () => getDslValue(scope, 'vars.buyer'),
        (error: unknown) => error instanceof DslRuntimeError && error.message === 'DSL ref not found: vars.buyer',
    );
    assert.throws(
        () => setDslValue(scope, 'session.user', 'alice'),
        (error: unknown) =>
            error instanceof DslRuntimeError && error.message === 'invalid DSL assignment root: session.user',
    );
    assert.throws(
        () => setDslValue(scope, 'vars', {}),
        (error: unknown) => error instanceof DslRuntimeError && error.message === 'cannot assign DSL root directly: vars',
    );
});
