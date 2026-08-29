import test from 'node:test';
import assert from 'node:assert/strict';
import {
    type InteractionCreatedEvent,
    type InteractionDecidedEvent,
    type InteractionEvent,
    type InteractionRecord,
} from '../../../../src/agent/interaction/contracts';
import {applyEvent, isTerminal, projectRecord, TERMINAL_STATUSES} from '../../../../src/agent/interaction/state';

const baseRecord = (patch: Partial<InteractionRecord> = {}): InteractionRecord => ({
    id: 'int-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    kind: 'irreversible-effect-approval',
    status: 'pending',
    createdAt: 100,
    deadlineAt: 200,
    revision: 0,
    prompt: 'Approve?',
    evidence: {summary: 'effect summary'},
    decision: null,
    ...patch,
});

const createdEvent = (patch: Partial<InteractionCreatedEvent> = {}): InteractionCreatedEvent => ({
    kind: 'created',
    id: 'int-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    interactionKind: 'irreversible-effect-approval',
    createdAt: 100,
    deadlineAt: 200,
    prompt: 'Approve?',
    evidence: {summary: 'effect summary'},
    revision: 0,
    ...patch,
});

test('terminal statuses are correctly identified', () => {
    assert.equal(isTerminal('pending'), false);
    for (const status of TERMINAL_STATUSES) {
        assert.equal(isTerminal(status), true);
    }
});

test('projectRecord builds pending record from created event', () => {
    const record = projectRecord([createdEvent()]);
    assert.equal(record.status, 'pending');
    assert.equal(record.revision, 0);
    assert.equal(record.decision, null);
});

test('projectRecord rejects empty event list', () => {
    assert.throws(() => projectRecord([]), /cannot project from empty event list/);
});

test('projectRecord rejects event list not starting with created', () => {
    const decided: InteractionDecidedEvent = {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'approve', approvedBy: 'user', approvedAt: 150},
        revision: 1,
    };
    assert.throws(() => projectRecord([decided]), /must start with created event/);
});

test('applyEvent approves a pending interaction', () => {
    const record = baseRecord();
    const event: InteractionDecidedEvent = {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'approve', approvedBy: 'user', approvedAt: 150},
        revision: 1,
    };
    const next = applyEvent(record, event);
    assert.equal(next.status, 'approved');
    assert.equal(next.revision, 1);
    assert.equal(next.decision?.kind, 'approve');
});

test('applyEvent denies a pending interaction', () => {
    const record = baseRecord();
    const event: InteractionDecidedEvent = {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'deny', deniedBy: 'user', deniedAt: 150, reason: 'unsafe'},
        revision: 1,
    };
    const next = applyEvent(record, event);
    assert.equal(next.status, 'denied');
    assert.equal(next.decision?.kind, 'deny');
});

test('applyEvent cancels a pending interaction', () => {
    const record = baseRecord();
    const event: InteractionEvent = {
        kind: 'cancelled',
        id: 'int-1',
        cancelledBy: 'user',
        cancelledAt: 150,
        revision: 1,
    };
    const next = applyEvent(record, event);
    assert.equal(next.status, 'cancelled');
    assert.equal(next.decision?.kind, 'cancel');
});

test('applyEvent expires a pending interaction', () => {
    const record = baseRecord();
    const event: InteractionEvent = {
        kind: 'expired',
        id: 'int-1',
        expiredAt: 250,
        revision: 1,
    };
    const next = applyEvent(record, event);
    assert.equal(next.status, 'expired');
    assert.equal(next.decision?.kind, 'expire');
});

test('applyEvent rejects id mismatch', () => {
    const record = baseRecord();
    const event: InteractionEvent = {
        kind: 'cancelled',
        id: 'int-2',
        cancelledBy: 'user',
        cancelledAt: 150,
        revision: 1,
    };
    assert.throws(() => applyEvent(record, event), /event id mismatch/);
});

test('applyEvent rejects non-consecutive revision', () => {
    const record = baseRecord({revision: 2});
    const event: InteractionDecidedEvent = {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'approve', approvedBy: 'user', approvedAt: 150},
        revision: 4,
    };
    assert.throws(() => applyEvent(record, event), /revision mismatch/);
});

test('applyEvent rejects applying created event', () => {
    const record = baseRecord();
    assert.throws(() => applyEvent(record, createdEvent()), /cannot apply created event/);
});

test('applyEvent rejects deciding a non-pending record', () => {
    const record = baseRecord({status: 'approved', revision: 1});
    const event: InteractionDecidedEvent = {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'approve', approvedBy: 'user', approvedAt: 150},
        revision: 2,
    };
    assert.throws(() => applyEvent(record, event), /cannot decide interaction in status approved/);
});

test('projectRecord replays events to the same snapshot deterministically', () => {
    const events: InteractionEvent[] = [
        createdEvent(),
        {
            kind: 'decided',
            id: 'int-1',
            decision: {kind: 'approve', approvedBy: 'user', approvedAt: 150},
            revision: 1,
        },
    ];
    const first = projectRecord(events);
    const second = projectRecord(events);
    assert.deepEqual(first, second);
    assert.equal(first.status, 'approved');
    assert.equal(first.revision, 1);
});
