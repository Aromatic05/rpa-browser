import test from 'node:test';
import assert from 'node:assert/strict';
import {
    type InteractionCreatedEvent,
    type InteractionDecidedEvent,
    type InteractionEvent,
    type InteractionPayload,
    type InteractionRecord,
} from '../../../../src/agent/interaction/contracts';
import {applyEvent, isTerminal, projectRecord, TERMINAL_STATUSES} from '../../../../src/agent/interaction/state';

const approvalPayload: InteractionPayload = {
    kind: 'approval',
    actionName: 'browser.submit',
    summary: 'publish the order',
    risk: 'irreversible',
};

const baseRecord = (patch: Partial<InteractionRecord> = {}): InteractionRecord => ({
    id: 'int-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    kind: 'approval',
    status: 'pending',
    createdAt: 100,
    deadlineAt: 200,
    revision: 0,
    payload: approvalPayload,
    decision: null,
    ...patch,
});

const createdEvent = (patch: Partial<InteractionCreatedEvent> = {}): InteractionCreatedEvent => ({
    kind: 'created',
    id: 'int-1',
    runId: 'run-1',
    sessionId: 'sess-1',
    interactionKind: 'approval',
    createdAt: 100,
    deadlineAt: 200,
    payload: approvalPayload,
    revision: 0,
    ...patch,
});

const decided = (decision: InteractionRecord['decision']): InteractionDecidedEvent => ({
    kind: 'decided',
    id: 'int-1',
    decision: decision!,
    revision: 1,
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
    assert.equal(record.stage, undefined);
});

test('a takeover record starts in the offered stage', () => {
    const record = projectRecord([createdEvent({
        interactionKind: 'takeover',
        payload: {kind: 'takeover', reason: '2FA', scope: 'workspace', guidanceModes: ['manual']},
    })]);
    assert.equal(record.stage, 'offered');
});

test('projectRecord rejects empty event list', () => {
    assert.throws(() => projectRecord([]), /cannot project from empty event list/);
});

test('projectRecord rejects event list not starting with created', () => {
    assert.throws(() => projectRecord([decided({kind: 'approve', approvedAt: 150})]), /must start with created event/);
});

test('applyEvent approves a pending interaction', () => {
    const next = applyEvent(baseRecord(), decided({kind: 'approve', approvedAt: 150}));
    assert.equal(next.status, 'approved');
    assert.equal(next.revision, 1);
    assert.equal(next.decision?.kind, 'approve');
});

test('applyEvent denies a pending interaction', () => {
    const next = applyEvent(baseRecord(), decided({kind: 'deny', deniedAt: 150, reason: 'unsafe'}));
    assert.equal(next.status, 'denied');
    assert.equal(next.decision?.kind, 'deny');
});

test('applyEvent answers a clarification', () => {
    const record = baseRecord({
        kind: 'clarification',
        payload: {kind: 'clarification', question: 'Which date?', schema: {field: 'date', type: 'date'}},
    });
    const next = applyEvent(record, decided({kind: 'answer', answeredAt: 150, value: '2026-09-01'}));
    assert.equal(next.status, 'answered');
    assert.equal(next.decision?.kind, 'answer');
});

test('applyEvent resolves a recovery choice', () => {
    const record = baseRecord({
        kind: 'recovery_decision',
        payload: {
            kind: 'recovery_decision',
            failureSummary: 'boom',
            options: [{id: 'retry', kind: 'retry', label: 'Retry', eligible: true}],
        },
    });
    const next = applyEvent(record, decided({kind: 'choose', chosenAt: 150, optionId: 'retry'}));
    assert.equal(next.status, 'resolved');
    assert.equal(next.decision?.kind, 'choose');
});

test('takeover staged active then returnControl resolves', () => {
    const record = projectRecord([createdEvent({
        interactionKind: 'takeover',
        payload: {kind: 'takeover', reason: '2FA', scope: 'workspace', guidanceModes: ['manual', 'teach']},
    })]);
    const active = applyEvent(record, {
        kind: 'staged',
        id: 'int-1',
        stage: 'active',
        revision: 1,
    });
    assert.equal(active.stage, 'active');
    assert.equal(active.status, 'pending');
    const resolved = applyEvent(active, {
        kind: 'decided',
        id: 'int-1',
        decision: {kind: 'returnControl', returnedAt: 160, mode: 'manual'},
        revision: 2,
    });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.stage, undefined);
    assert.equal(resolved.decision?.kind, 'returnControl');
});

test('returnControl before active is rejected', () => {
    const record = projectRecord([createdEvent({
        interactionKind: 'takeover',
        payload: {kind: 'takeover', reason: '2FA', scope: 'workspace', guidanceModes: ['manual']},
    })]);
    assert.throws(
        () => applyEvent(record, decided({kind: 'returnControl', returnedAt: 150, mode: 'manual'})),
        /before the takeover is active/,
    );
});

test('applyEvent cancels a pending interaction', () => {
    const next = applyEvent(baseRecord(), {
        kind: 'cancelled',
        id: 'int-1',
        cancelledBy: 'user',
        cancelledAt: 150,
        revision: 1,
    });
    assert.equal(next.status, 'cancelled');
    assert.equal(next.decision?.kind, 'cancel');
});

test('applyEvent expires a pending interaction', () => {
    const next = applyEvent(baseRecord(), {kind: 'expired', id: 'int-1', expiredAt: 250, revision: 1});
    assert.equal(next.status, 'expired');
    assert.equal(next.decision?.kind, 'expire');
});

test('applyEvent rejects id mismatch', () => {
    assert.throws(() => applyEvent(baseRecord(), {
        kind: 'cancelled',
        id: 'int-2',
        cancelledBy: 'user',
        cancelledAt: 150,
        revision: 1,
    }), /event id mismatch/);
});

test('applyEvent rejects non-consecutive revision', () => {
    assert.throws(() => applyEvent(baseRecord({revision: 2}), decided({kind: 'approve', approvedAt: 150})), /revision mismatch/);
});

test('applyEvent rejects applying created event', () => {
    assert.throws(() => applyEvent(baseRecord(), createdEvent()), /cannot apply created event/);
});

test('applyEvent rejects deciding a non-pending record', () => {
    const decidedEvent = decided({kind: 'approve', approvedAt: 150});
    const event: InteractionDecidedEvent = {...decidedEvent, revision: 2};
    assert.throws(() => applyEvent(baseRecord({status: 'approved', revision: 1}), event), /cannot decide interaction in status approved/);
});

test('projectRecord replays events to the same snapshot deterministically', () => {
    const events: InteractionEvent[] = [
        createdEvent(),
        decided({kind: 'approve', approvedAt: 150}),
    ];
    const first = projectRecord(events);
    const second = projectRecord(events);
    assert.deepEqual(first, second);
    assert.equal(first.status, 'approved');
    assert.equal(first.revision, 1);
});