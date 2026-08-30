import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    type InteractionEvent,
    type InteractionPayload,
} from '../../../../src/agent/interaction/contracts';
import {createInteractionRepository} from '../../../../src/agent/interaction/repository';

const approvalPayload: InteractionPayload = {
    kind: 'approval',
    actionName: 'browser.submit',
    summary: 'publish the order',
    risk: 'irreversible',
};

const makeInput = (patch: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    sessionId: 'sess-1',
    kind: 'approval' as const,
    payload: approvalPayload,
    deadlineAt: 200,
    createdAt: 100,
    ...patch,
});

test('create assigns a unique id and starts at revision 0 pending', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());

    assert.ok(record.id.length > 0);
    assert.equal(record.status, 'pending');
    assert.equal(record.revision, 0);
    assert.equal(record.decision, null);
    assert.equal(record.runId, 'run-1');
    assert.equal(record.sessionId, 'sess-1');
    assert.deepEqual(record.payload, approvalPayload);
});

test('get returns null for unknown id', () => {
    const repo = createInteractionRepository();
    assert.equal(repo.get('missing'), null);
    assert.equal(repo.getEvents('missing'), null);
});

test('get returns projected record from events', () => {
    const repo = createInteractionRepository();
    const {record, event} = repo.create(makeInput());
    const got = repo.get(record.id);
    assert.deepEqual(got, record);
    assert.deepEqual(repo.getEvents(record.id), [event]);
});

test('decide approves with matching revision', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    const decided = repo.decide(record.id, record.revision, {kind: 'approve', approvedAt: 150});
    assert.equal(decided.status, 'approved');
    assert.equal(decided.revision, 1);
    assert.equal(decided.decision?.kind, 'approve');
});

test('decide denies with matching revision', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    const decided = repo.decide(record.id, record.revision, {
        kind: 'deny',
        deniedAt: 150,
        reason: 'unsafe',
        requestedAlternative: 'use a review step instead',
    });
    assert.equal(decided.status, 'denied');
    assert.equal(decided.revision, 1);
    assert.equal(decided.decision?.kind, 'deny');
    assert.equal(decided.decision && 'requestedAlternative' in decided.decision && decided.decision.requestedAlternative, 'use a review step instead');
});

test('decide rejects stale revision', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    repo.decide(record.id, record.revision, {kind: 'approve', approvedAt: 150});
    assert.throws(
        () => repo.decide(record.id, record.revision, {kind: 'approve', approvedAt: 160}),
        InteractionConcurrencyError,
    );
});

test('double approve race loses on stale revision', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    const first = repo.decide(record.id, 0, {kind: 'approve', approvedAt: 150});
    assert.equal(first.status, 'approved');
    assert.throws(
        () => repo.decide(record.id, 0, {kind: 'approve', approvedAt: 151}),
        InteractionConcurrencyError,
    );
});

test('deny after approve is rejected because record is terminal', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    repo.decide(record.id, 0, {kind: 'approve', approvedAt: 150});
    assert.throws(
        () => repo.decide(record.id, 1, {kind: 'deny', deniedAt: 151, reason: 'changed mind'}),
        InteractionStateError,
    );
});

test('cancel transitions pending to cancelled', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    const cancelled = repo.cancel(record.id, record.revision, 'user-a', 150);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.revision, 1);
    assert.equal(cancelled.decision?.kind, 'cancel');
});

test('cancel rejects stale revision', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    repo.cancel(record.id, record.revision, 'user-a', 150);
    assert.throws(
        () => repo.cancel(record.id, record.revision, 'user-b', 151),
        InteractionConcurrencyError,
    );
});

test('expire transitions pending to expired', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    const expired = repo.expire(record.id, record.revision, 250);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.revision, 1);
});

test('expire rejects already decided record', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    repo.decide(record.id, record.revision, {kind: 'approve', approvedAt: 150});
    assert.throws(() => repo.expire(record.id, 1, 250), InteractionStateError);
});

test('stage moves a pending takeover to active exactly once', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput({
        kind: 'takeover',
        payload: {kind: 'takeover', reason: '2FA required', scope: 'workspace', guidanceModes: ['manual', 'teach']},
    }));
    assert.equal(record.stage, 'offered');
    const active = repo.stage(record.id, record.revision, 'active');
    assert.equal(active.stage, 'active');
    assert.equal(active.status, 'pending');
    assert.throws(
        () => repo.stage(record.id, active.revision, 'active'),
        InteractionStateError,
    );
});

test('stage is rejected for non-takeover kinds', () => {
    const repo = createInteractionRepository();
    const {record} = repo.create(makeInput());
    assert.throws(() => repo.stage(record.id, record.revision, 'active'), InteractionStateError);
});

test('list returns all records', () => {
    const repo = createInteractionRepository();
    const a = repo.create(makeInput({runId: 'run-a'}));
    const b = repo.create(makeInput({runId: 'run-b'}));
    const ids = repo.list().map((record) => record.id).sort();
    assert.deepEqual(ids, [a.record.id, b.record.id].sort());
});

test('listByRun filters by runId', () => {
    const repo = createInteractionRepository();
    repo.create(makeInput({runId: 'run-a'}));
    repo.create(makeInput({runId: 'run-b'}));
    assert.equal(repo.listByRun('run-a').length, 1);
    assert.equal(repo.listByRun('run-b').length, 1);
    assert.equal(repo.listByRun('run-c').length, 0);
});

test('listBySession filters by sessionId', () => {
    const repo = createInteractionRepository();
    repo.create(makeInput({sessionId: 'sess-a'}));
    repo.create(makeInput({sessionId: 'sess-b'}));
    assert.equal(repo.listBySession('sess-a').length, 1);
    assert.equal(repo.listBySession('sess-c').length, 0);
});

test('projectFromEvents reconstructs snapshot from external events', () => {
    const repo = createInteractionRepository();
    const {record, event} = repo.create(makeInput());
    const decided = repo.decide(record.id, record.revision, {kind: 'approve', approvedAt: 150});
    const events = repo.getEvents(record.id);
    assert.ok(events);
    const replayed = repo.projectFromEvents(events);
    assert.deepEqual(replayed, decided);
});

test('initial events hydrate repository on creation', () => {
    const events: InteractionEvent[] = [
        {
            kind: 'created',
            id: 'int-1',
            runId: 'run-1',
            sessionId: 'sess-1',
            interactionKind: 'takeover',
            createdAt: 100,
            deadlineAt: 200,
            payload: {kind: 'takeover', reason: 'automation stuck', scope: 'tab', guidanceModes: ['manual']},
            revision: 0,
        },
        {
            kind: 'staged',
            id: 'int-1',
            stage: 'active',
            revision: 1,
        },
        {
            kind: 'decided',
            id: 'int-1',
            decision: {kind: 'returnControl', returnedAt: 150, mode: 'manual'},
            revision: 2,
        },
    ];
    const repo = createInteractionRepository({initial: [events]});
    const record = repo.get('int-1');
    assert.ok(record);
    assert.equal(record.status, 'resolved');
    assert.equal(record.kind, 'takeover');
    assert.equal(record.decision?.kind, 'returnControl');
});