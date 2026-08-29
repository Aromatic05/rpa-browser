import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    InteractionValidationError,
    type InteractionEvent,
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

const makeRequest = (patch: Record<string, unknown> = {}) => ({
    runId: 'run-1',
    sessionId: 'sess-1',
    kind: 'irreversible-effect-approval' as const,
    prompt: 'Approve irreversible effect?',
    evidence: {summary: 'will click submit'},
    deadlineAt: NOW + 100,
    ...patch,
});

test('request creates a pending interaction with revision 0', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    assert.equal(record.status, 'pending');
    assert.equal(record.revision, 0);
    assert.equal(record.kind, 'irreversible-effect-approval');
});

test('request supports all interaction kinds', () => {
    const kinds = [
        'irreversible-effect-approval',
        'recovery-confirmation',
        'user-input-clarification',
        'takeover',
    ] as const;
    for (const kind of kinds) {
        const {service} = makeService();
        const record = service.request(makeRequest({kind}));
        assert.equal(record.kind, kind);
    }
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

test('request rejects evidence with raw scope or tool args', () => {
    const {service} = makeService();
    for (const badKey of ['rawArgs', 'scope', 'arguments', 'payload', 'context']) {
        assert.throws(
            () => service.request(makeRequest({evidence: {summary: 'ok', [badKey]: 'secret'}})),
            InteractionValidationError,
            `expected rejection for ${badKey}`,
        );
    }
});

test('request rejects evidence with missing summary', () => {
    const {service} = makeService();
    assert.throws(
        () => service.request(makeRequest({evidence: {}})),
        InteractionValidationError,
    );
});

test('request rejects invalid risk level', () => {
    const {service} = makeService();
    assert.throws(
        () => service.request(makeRequest({evidence: {summary: 'ok', riskLevel: 'extreme'}})),
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
    if (approved.decision?.kind === 'approve') {
        assert.equal(approved.decision.approvedBy, 'user-a');
    }
});

test('deny transitions pending to denied', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const denied = service.deny(record.id, record.revision, 'user-a', 'too risky');
    assert.equal(denied.status, 'denied');
    assert.equal(denied.revision, 1);
    assert.equal(denied.decision?.kind, 'deny');
});

test('cancel transitions pending to cancelled', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const cancelled = service.cancel(record.id, record.revision, 'user-a');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.revision, 1);
});

test('approve is idempotent when retried with matching user', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const first = service.approve(record.id, record.revision, 'user-a');
    const second = service.approve(record.id, first.revision, 'user-a');
    assert.deepEqual(first, second);
    assert.equal(second.revision, 1);
});

test('deny is idempotent when retried with matching user and reason', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const first = service.deny(record.id, record.revision, 'user-a', 'unsafe');
    const second = service.deny(record.id, first.revision, 'user-a', 'unsafe');
    assert.deepEqual(first, second);
});

test('cancel is idempotent when retried with matching user', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const first = service.cancel(record.id, record.revision, 'user-a');
    const second = service.cancel(record.id, first.revision, 'user-a');
    assert.deepEqual(first, second);
});

test('approve by different user after approval is rejected', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    service.approve(record.id, record.revision, 'user-a');
    assert.throws(
        () => service.approve(record.id, 1, 'user-b'),
        InteractionStateError,
    );
});

test('deny after approve is rejected', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    service.approve(record.id, record.revision, 'user-a');
    assert.throws(
        () => service.deny(record.id, 1, 'user-b', 'no'),
        InteractionStateError,
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

test('decision after deadline expires the interaction instead', () => {
    let now = NOW;
    const {service} = makeService(() => now);
    const record = service.request(makeRequest({deadlineAt: NOW + 10}));
    now = NOW + 11;
    const expired = service.approve(record.id, record.revision, 'user-a');
    assert.equal(expired.status, 'expired');
    assert.equal(expired.decision?.kind, 'expire');
});

test('expire explicitly transitions pending to expired', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const expired = service.expire(record.id, record.revision);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.revision, 1);
});

test('expire is idempotent', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    const first = service.expire(record.id, record.revision);
    const second = service.expire(record.id, first.revision);
    assert.deepEqual(first, second);
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

test('malformed transition from terminal status is rejected', () => {
    const {service} = makeService();
    const record = service.request(makeRequest());
    service.deny(record.id, record.revision, 'user-a', 'no');
    assert.throws(() => service.approve(record.id, 1, 'user-b'), InteractionStateError);
    assert.throws(() => service.cancel(record.id, 1, 'user-b'), InteractionStateError);
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

test('takeover interaction lifecycle', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'takeover',
        prompt: 'Human operator required',
        evidence: {summary: 'automation stuck on captcha'},
    }));
    assert.equal(record.kind, 'takeover');
    const approved = service.approve(record.id, record.revision, 'operator-1');
    assert.equal(approved.status, 'approved');
    assert.equal(approved.decision?.kind, 'approve');
});

test('recovery confirmation can be denied', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'recovery-confirmation',
        prompt: 'Retry failed step?',
        evidence: {summary: 'network error on step 3'},
    }));
    const denied = service.deny(record.id, record.revision, 'user-a', 'prefer abort');
    assert.equal(denied.status, 'denied');
});

test('user clarification request can be cancelled', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        kind: 'user-input-clarification',
        prompt: 'Which category?',
        evidence: {summary: 'ambiguous user instruction'},
    }));
    const cancelled = service.cancel(record.id, record.revision, 'user-a');
    assert.equal(cancelled.status, 'cancelled');
});

test('sanitized evidence boundaries preserve allowed fields', () => {
    const {service} = makeService();
    const record = service.request(makeRequest({
        evidence: {
            summary: 'allowed summary',
            effectName: 'submit-form',
            toolName: 'browser.click',
            riskLevel: 'high',
            tags: ['checkout', 'payment'],
        },
    }));
    assert.equal(record.evidence.summary, 'allowed summary');
    assert.equal(record.evidence.effectName, 'submit-form');
    assert.equal(record.evidence.toolName, 'browser.click');
    assert.equal(record.evidence.riskLevel, 'high');
    assert.deepEqual(record.evidence.tags, ['checkout', 'payment']);
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
            interactionKind: 'irreversible-effect-approval',
            createdAt: NOW,
            deadlineAt: NOW + 100,
            prompt: 'Approve?',
            evidence: {summary: 'effect'},
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
