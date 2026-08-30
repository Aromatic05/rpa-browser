import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionManager, SessionCancelledError, ActivityConflictError} from '../../../../../src/agent/service/session/manager';
import type {AgentRunResult} from '../../../../../src/agent/execution/types';
import {deferred, flush, makeRequest, makeResult} from './helpers';

const pausedResult = (): AgentRunResult => makeResult({
    programs: [{source: 'output ok = input.ok', input: {}, status: 'paused'}],
});

test('run settles a completed session and returns the exact result', async () => {
    const result = makeResult();
    const manager = createSessionManager({runner: {run: async () => result}});

    const runResult = await manager.run(makeRequest());
    assert.deepEqual(runResult, result);

    const sessions = manager.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].state, 'completed');
    assert.equal(typeof sessions[0].sessionId, 'string');
    assert.deepEqual(sessions[0].result, result);
    assert.equal(sessions[0].error, null);
});

test('run maps a paused program to a retained paused session', async () => {
    const manager = createSessionManager({runner: {run: async () => pausedResult()}});
    await manager.run(makeRequest());

    const [session] = manager.list();
    assert.equal(session.state, 'paused');
    assert.equal(session.result?.programs?.[0].status, 'paused');
    assert.equal(session.error, null);
});

test('run rethrows runner errors and retains a failed session with the error code', async () => {
    const manager = createSessionManager({
        runner: {run: async () => {throw Object.assign(new Error('boom'), {code: 'ERR_BOOM'});}},
    });

    await assert.rejects(() => manager.run(makeRequest()), /boom/);

    const [session] = manager.list();
    assert.equal(session.state, 'failed');
    assert.deepEqual(session.error, {code: 'ERR_BOOM', message: 'boom'});
    assert.equal(session.result, null);
});

test('start returns a running snapshot before the runner settles', async () => {
    const pending = deferred<AgentRunResult>();
    const manager = createSessionManager({runner: {run: () => pending.promise}});

    const snapshot = manager.start(makeRequest());
    assert.equal(snapshot.state, 'running');
    assert.equal(manager.status(snapshot.sessionId)?.state, 'running');

    pending.resolve(makeResult());
    await flush();

    assert.equal(manager.status(snapshot.sessionId)?.state, 'completed');
});

test('cancel aborts a running session and marks it cancelled', async () => {
    const pending = deferred<AgentRunResult>();
    const manager = createSessionManager({runner: {run: () => pending.promise}});

    const snapshot = manager.start(makeRequest());
    const cancelled = manager.cancel(snapshot.sessionId);

    assert.equal(cancelled?.state, 'cancelled');
    assert.deepEqual(cancelled?.error, {code: 'ERR_SESSION_CANCELLED', message: `session ${snapshot.sessionId} was cancelled`});
    await flush();
    assert.equal(manager.status(snapshot.sessionId)?.state, 'cancelled');
});

test('cancel is idempotent after a terminal state and unknown ids return null', async () => {
    const manager = createSessionManager({runner: {run: async () => makeResult()}});
    await manager.run(makeRequest());

    const [session] = manager.list();
    assert.equal(manager.cancel(session.sessionId)?.state, 'completed');
    assert.equal(manager.cancel('missing'), null);
});

test('run rethrows a SessionCancelledError when the session is aborted externally', async () => {
    const pending = deferred<AgentRunResult>();
    const manager = createSessionManager({runner: {run: () => pending.promise}});

    const runPromise = manager.run(makeRequest());
    const sessions = manager.list();
    assert.equal(sessions.length, 1);

    manager.cancel(sessions[0].sessionId);
    await assert.rejects(() => runPromise, SessionCancelledError);
    await flush();

    assert.equal(manager.status(sessions[0].sessionId)?.state, 'cancelled');
});

test('one active task holds the workspace reservation and rejects a second start', async () => {
    const first = deferred<AgentRunResult>();
    const second = deferred<AgentRunResult>();
    const manager = createSessionManager({
        runner: {
            run: (request) => request.prompt === 'first' ? first.promise : second.promise,
        },
    });

    const a = manager.start(makeRequest({prompt: 'first'}));
    assert.notEqual(a.sessionId, '');
    assert.equal(manager.activityReservation().owner, 'task');
    assert.throws(
        () => manager.start(makeRequest({prompt: 'second'})),
        ActivityConflictError,
        'a second task must be rejected while the first holds the reservation',
    );

    first.resolve(makeResult({text: 'a'}));
    await flush();
    assert.equal(manager.status(a.sessionId)?.state, 'completed');
    assert.equal(manager.activityReservation().owner, 'none', 'terminal settle releases the reservation');

    const b = manager.start(makeRequest({prompt: 'second'}));
    assert.equal(manager.activityReservation().owner, 'task');
    second.resolve(makeResult({text: 'b'}));
    await flush();
    assert.equal(manager.status(b.sessionId)?.state, 'completed');
    assert.equal(manager.activityReservation().owner, 'none');
    assert.equal(manager.list().length, 2);
});

test('runTracked exposes the stable session id alongside the result', async () => {
    const manager = createSessionManager({runner: {run: async () => makeResult()}});
    const tracked = await manager.runTracked(makeRequest());

    assert.equal(typeof tracked.sessionId, 'string');
    assert.deepEqual(tracked.result, makeResult());
    assert.equal(manager.list()[0].sessionId, tracked.sessionId);
});
