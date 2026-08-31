import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
    validateInteractionPayload,
    validateModelRequestedInteraction,
    type InteractionEvent,
    type InteractionPayload,
} from '../../../../src/agent/interaction/contracts';
import {createInteractionRepository} from '../../../../src/agent/interaction/repository';
import {createInteractionService} from '../../../../src/agent/interaction/service';

const NOW = 1000;

const makeService = (now: (() => number) | number = NOW) => {
    const repository = createInteractionRepository();
    const clock = typeof now === 'number' ? () => now : now;
    const service = createInteractionService({repository, now: clock});
    return {repository, service};
};

const approvalPayload: InteractionPayload = {
    kind: 'approval',
    actionName: 'browser.submit',
    summary: 'publish the order to ERP',
    risk: 'irreversible',
};

const makeRequest = (patch: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    sessionId: 'sess-1',
    kind: 'approval' as const,
    payload: approvalPayload,
    deadlineAt: NOW + 100,
    ...patch,
});

test('request creates a pending interaction with revision 0', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    assert.equal(record.status, 'pending');
    assert.equal(record.revision, 0);
    assert.equal(record.kind, 'approval');
    assert.deepEqual(record.payload, approvalPayload);
});

test('request validates the typed payload and rejects raw blobs', () => {
    const {service} = makeService();
    assert.throws(
        () => service.request(makeRequest({payload: {kind: 'approval', summary: 'no actionName', risk: 'irreversible'}})),
        InteractionValidationError,
    );
    assert.throws(
        () => service.request(makeRequest({payload: {kind: 'clarification', question: 'q'}})),
        InteractionValidationError,
    );
    assert.throws(
        () => service.request(makeRequest({payload: {kind: 'recovery_decision', failureSummary: 's', options: []}})),
        InteractionValidationError,
    );
    assert.throws(
        () => service.request(makeRequest({payload: {kind: 'takeover', reason: 'r', guidanceModes: ['chat']}})),
        InteractionValidationError,
    );
});

test('the model-request validator rejects approval without weakening the generic validator', () => {
    const approval = {kind: 'approval', actionName: 'browser.click', summary: 's', risk: 'irreversible'};
    assert.equal(validateInteractionPayload(approval).kind, 'approval', 'the SessionManager validator still accepts approval');
    assert.throws(() => validateModelRequestedInteraction(approval), InteractionValidationError);
    assert.equal(
        validateModelRequestedInteraction({kind: 'clarification', question: 'q', schema: {field: 'f', type: 'text'}}).kind,
        'clarification',
    );
    assert.equal(
        validateModelRequestedInteraction({kind: 'recovery_decision', failureSummary: 's', options: [{id: 'r', kind: 'retry', label: 'Retry', eligible: true}]}).kind,
        'recovery_decision',
    );
    assert.equal(
        validateModelRequestedInteraction({kind: 'takeover', reason: 'r', scope: 'workspace', guidanceModes: ['manual']}).kind,
        'takeover',
    );
});

test('request validates deadline ordering', () => {
    const {service} = makeService();
    assert.throws(
        () => service.request(makeRequest({deadlineAt: NOW})),
        InteractionValidationError,
    );
    assert.throws(
        () => service.request(makeRequest({deadlineAt: NOW - 1})),
        InteractionValidationError,
    );
});

test('approve transitions pending to approved', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const approved = service.approve(record.id, record.revision, 'user-a');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.revision, 1);
    assert.equal(approved.decision?.kind, 'approve');
});

test('deny carries a required reason and optional requestedAlternative', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    assert.throws(
        () => service.deny(record.id, record.revision, 'user-a', '   '),
        InteractionValidationError,
    );
    const denied = service.deny(record.id, record.revision, 'user-a', 'too risky', 'route it to a review step');
    assert.equal(denied.status, 'denied');
    assert.equal(denied.revision, 1);
    assert.equal(denied.decision?.kind, 'deny');
    if (denied.decision?.kind === 'deny') {
        assert.equal(denied.decision.reason, 'too risky');
        assert.equal(denied.decision.requestedAlternative, 'route it to a review step');
    }
});

test('cancel transitions pending to cancelled', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const cancelled = service.cancel(record.id, record.revision, 'user-a');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.revision, 1);
});

test('deny and approve are only valid for approval interactions', () => {
    const {service} = makeService();
    const clarification = service.request(makeRequest({
        kind: 'clarification',
        payload: {kind: 'clarification', question: 'Which date?', schema: {field: 'date', type: 'date'}},
    }));
    assert.throws(
        () => service.approve(clarification.id, clarification.revision, 'user-a'),
        InteractionValidationError,
    );
    assert.throws(
        () => service.deny(clarification.id, clarification.revision, 'user-a', 'no'),
        InteractionValidationError,
    );
});

test('double decision race loses on stale revision', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    service.approve(record.id, 0, 'user-a');
    assert.throws(
        () => service.deny(record.id, 0, 'user-b', 'no'),
        InteractionConcurrencyError,
    );
});

test('decision after deadline expires the interaction instead of resolving', () => {
    let now = NOW;
    const {service} = makeService(() => now);
    const record = service.request(makeRequest({deadlineAt: NOW + 10}));
    now = NOW + 11;
    const expired = service.approve(record.id, record.revision, 'user-a');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.decision?.kind, 'expire');
});

test('expire explicitly transitions pending to expired and is idempotent', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const expired = service.expire(record.id, record.revision);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.revision, 1);
    assert.deepEqual(service.expire(record.id, expired.revision), expired);
});

test('expire rejects already approved interaction', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    service.approve(record.id, record.revision, 'user-a');
    assert.throws(
        () => service.expire(record.id, 1),
        InteractionStateError,
    );
});

test('clarification answer is validated against the schema', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'clarification',
        payload: {
            kind: 'clarification',
            question: 'Which delivery date?',
            schema: {field: 'date', type: 'date'},
        },
    }));
    assert.throws(
        () => service.answer(record.id, record.revision, 'user-a', 'not-a-date'),
        InteractionValidationError,
    );
    const answered = service.answer(record.id, record.revision, 'user-a', '2026-09-01');
    assert.equal(answered.status, 'answered');
    assert.equal(answered.decision?.kind, 'answer');
    if (answered.decision?.kind === 'answer') {
        assert.equal(answered.decision.value, '2026-09-01');
    }
});

test('clarification answer honors allowed/min/max/maxLength', () => {
    const {service} = makeService();
    const select = service.request(makeRequest({
        kind: 'clarification',
        payload: {
            kind: 'clarification',
            question: 'Category?',
            schema: {field: 'category', type: 'select', allowed: ['a', 'b']},
        },
    }));
    assert.throws(() => service.answer(select.id, select.revision, 'user-a', 'c'), InteractionValidationError);
    const number = service.request(makeRequest({
        kind: 'clarification',
        payload: {kind: 'clarification', question: 'Count?', schema: {field: 'count', type: 'number', min: 1, max: 5}},
    }));
    assert.throws(() => service.answer(number.id, number.revision, 'user-a', 6), InteractionValidationError);
    const text = service.request(makeRequest({
        kind: 'clarification',
        payload: {kind: 'clarification', question: 'Name?', schema: {field: 'name', type: 'text', maxLength: 3}},
    }));
    assert.throws(() => service.answer(text.id, text.revision, 'user-a', 'toolong'), InteractionValidationError);
});

test('recovery choice is validated against the actual options and eligibility', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'recovery_decision',
        payload: {
            kind: 'recovery_decision',
            failureSummary: 'step failed',
            options: [
                {id: 'retry', kind: 'retry', label: 'Retry', eligible: true},
                {id: 'rollback', kind: 'rollback', label: 'Rollback', eligible: false, block: {code: 'no_recovery_point', message: 'no anchor'}},
            ],
        },
    }));
    assert.throws(() => service.choose(record.id, record.revision, 'user-a', 'missing'), InteractionValidationError);
    assert.throws(() => service.choose(record.id, record.revision, 'user-a', 'rollback'), InteractionValidationError);
    const chosen = service.choose(record.id, record.revision, 'user-a', 'retry');
    assert.equal(chosen.status, 'resolved');
    assert.equal(chosen.decision?.kind, 'choose');
    if (chosen.decision?.kind === 'choose') {
        assert.equal(chosen.decision.optionId, 'retry');
    }
});

test('takeover stages offered -> active and resolves only via returnControl', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'takeover',
        payload: {kind: 'takeover', reason: '2FA required', scope: 'workspace', guidanceModes: ['manual', 'teach']},
    }));
    assert.equal(record.stage, 'offered');
    assert.throws(
        () => service.beginGuidance(record.id, record.revision, 'user-a', 'annotate'),
        InteractionValidationError,
    );
    const active = service.beginGuidance(record.id, record.revision, 'user-a', 'manual');
    assert.equal(active.status, 'pending');
    assert.equal(active.stage, 'active');
    assert.throws(
        () => service.approve(active.id, active.revision, 'user-a'),
        InteractionValidationError,
        'an approval-style resolution is not valid for a takeover',
    );
    const resolved = service.returnControl(active.id, active.revision, 'user-a', 'manual', 'checkpoint:proc-1');
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.decision?.kind, 'returnControl');
    if (resolved.decision?.kind === 'returnControl') {
        assert.equal(resolved.decision.savedReference, 'checkpoint:proc-1');
    }
});

test('get returns null for unknown id', () => {
    const {service} = makeService();
    assert.equal(service.get('missing'), null);
});

test('listByRun and listBySession filter correctly', () => {
    const {service} = makeService();
    const a = service.request(makeRequest({runId: 'run-a', sessionId: 'sess-a'}));
    const b = service.request(makeRequest({runId: 'run-a', sessionId: 'sess-b'}));
    service.request(makeRequest({runId: 'run-b', sessionId: 'sess-c'}));

    assert.equal(service.listByRun('run-a').length, 2);
    assert.equal(service.listByRun('run-b').length, 1);
    assert.equal(service.listBySession('sess-a').length, 1);
    assert.deepEqual(
        service.listBySession('sess-a').map((record) => record.id),
        [a.id],
    );
    assert.equal(service.listBySession('sess-b').length, 1);
    assert.deepEqual(
        service.listBySession('sess-b').map((record) => record.id),
        [b.id],
    );
});

test('replaying repository events reproduces service snapshot', () => {
    const {repository, service} = makeService();
    const record = service.request(makeRequest());
    service.approve(record.id, record.revision, 'user-a');

    const events = repository.getEvents(record.id);
    assert.ok(events);
    const replayed = repository.projectFromEvents(events);
    const current = service.get(record.id);
    assert.deepEqual(replayed, current);
    assert.equal(replayed.status, 'approved');
});

test('events are append-only and ordered', () => {
    const {repository, service} = makeService();
    const record = service.request(makeRequest());
    service.deny(record.id, record.revision, 'user-a', 'unsafe');

    const events = repository.getEvents(record.id);
    assert.ok(events);
    assert.equal(events.length, 2);
    assert.equal(events[0].kind, 'created');
    assert.equal(events[1].kind, 'decided');
    assert.equal(events[0].revision, 0);
    assert.equal(events[1].revision, 1);
});

test('service uses injected clock for timestamps', () => {
    let now = NOW;
    const {service} = makeService(() => now);
    const record = service.request(makeRequest());
    now = NOW + 5;
    const approved = service.approve(record.id, record.revision, 'user-a');
    assert.equal(approved.decision?.kind, 'approve');
    if (approved.decision?.kind === 'approve') {
        assert.equal(approved.decision.approvedAt, NOW + 5);
    }
});

test('repository initial events integrate with service reads', () => {
    const events: InteractionEvent[] = [
        {
            kind: 'created',
            id: 'int-1',
            runId: 'run-1',
            sessionId: 'sess-1',
            interactionKind: 'approval',
            createdAt: NOW,
            deadlineAt: NOW + 100,
            payload: approvalPayload,
            revision: 0,
        },
    ];
    const repository = createInteractionRepository({initial: [events]});
    const service = createInteractionService({repository, now: () => NOW});
    const record = service.get('int-1');
    assert.ok(record);
    assert.equal(record.status, 'pending');

    const approved = service.approve('int-1', record.revision, 'user-a');
    assert.equal(approved.status, 'approved');
});