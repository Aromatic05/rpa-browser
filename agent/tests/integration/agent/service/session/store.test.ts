import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore} from '../../../../../src/agent/service/session/store';
import {makeRequest, makeResult} from './helpers';

test('store assigns a stable unique session id and starts running', () => {
    const store = createSessionStore();
    const first = store.create(makeRequest({prompt: 'one'}));
    const second = store.create(makeRequest({prompt: 'two'}));

    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(first.state, 'running');
    assert.equal(second.state, 'running');
    assert.equal(first.startedAt, first.createdAt);
    assert.equal(first.endedAt, null);
    assert.equal(first.result, null);
    assert.equal(first.error, null);
    assert.equal(first.request.prompt, 'one');
    assert.equal(second.request.prompt, 'two');
});

test('store settles a session once and ignores later transitions', () => {
    const store = createSessionStore();
    const {sessionId} = store.create(makeRequest());
    const result = makeResult();

    const settled = store.settle(sessionId, {state: 'completed', result});
    assert.equal(settled?.state, 'completed');
    assert.deepEqual(settled?.result, result);
    assert.ok(settled?.endedAt);

    const again = store.settle(sessionId, {state: 'failed', error: {code: 'ERR_X', message: 'late'}});
    assert.equal(again?.state, 'completed');
    assert.deepEqual(again?.result, result);
    assert.equal(again?.error, null);
});

test('store get returns null for unknown ids and clear empties retention', () => {
    const store = createSessionStore();
    assert.equal(store.get('missing'), null);

    const {sessionId} = store.create(makeRequest());
    assert.ok(store.get(sessionId));
    assert.equal(store.list().length, 1);

    store.clear();
    assert.equal(store.get(sessionId), null);
    assert.equal(store.list().length, 0);
});

test('store list preserves creation order', () => {
    const store = createSessionStore();
    const a = store.create(makeRequest({prompt: 'a'}));
    const b = store.create(makeRequest({prompt: 'b'}));
    assert.deepEqual(store.list().map((snapshot) => snapshot.sessionId), [a.sessionId, b.sessionId]);
});
