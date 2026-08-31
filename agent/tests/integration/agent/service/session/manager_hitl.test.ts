import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionConcurrencyError,
    InteractionStateError,
    type ModelRequestedInteraction,
} from '../../../../../src/agent/interaction/contracts';
import {createSessionManager, ActivityConflictError} from '../../../../../src/agent/service/session/manager';
import type {
    AgentControlInput,
    AgentProgramPause,
    AgentRunResult,
} from '../../../../../src/agent/execution/types';
import {makeRequest, makeResult} from './helpers';

const approvalPause = (continuationId = 'cont-1'): AgentProgramPause => ({
    reason: 'barrier',
    continuationId,
    stepName: 'browser.submit',
    risk: 'irreversible',
});

const pausedProgram = (pause: AgentProgramPause) => ({
    source: 'output s = input.secret',
    input: {secret: 'do-not-leak'},
    status: 'paused' as const,
    pause,
});

const makeHarness = (options: {
    pause?: AgentProgramPause;
    withContinuation?: boolean;
    resumeAgainPause?: AgentProgramPause;
    resumeThrows?: {code: string; message: string};
    controlThrows?: {code: string; message: string};
    controlResult?: (input: AgentControlInput) => AgentRunResult;
    interactionPolicy?: 'interactive' | 'headless';
    requestedInteraction?: ModelRequestedInteraction;
} = {}) => {
    const stats = {runCalls: 0, resumeCalls: 0, controlCalls: 0};
    const controlInputs: AgentControlInput[] = [];
    const paused = (pause: AgentProgramPause, continuation: boolean): AgentRunResult => {
        const base = makeResult({programs: [pausedProgram(pause)]});
        if (!continuation) {return base;}
        return {
            ...base,
            ...(options.requestedInteraction ? {requestedInteraction: options.requestedInteraction} : {}),
            continuation: {
                resume: async () => {
                    stats.resumeCalls += 1;
                    if (options.resumeThrows) {
                        throw Object.assign(new Error(options.resumeThrows.message), {code: options.resumeThrows.code});
                    }
                    if (options.resumeAgainPause) {
                        const again = makeResult({programs: [pausedProgram(options.resumeAgainPause)]});
                        return {...again, continuation: {
                            resume: async () => {
                                stats.resumeCalls += 1;
                                return makeResult({text: 'resumed'});
                            },
                        }};
                    }
                    return makeResult({text: 'resumed'});
                },
            },
            control: {
                control: async (input) => {
                    stats.controlCalls += 1;
                    controlInputs.push(input);
                    if (options.controlThrows) {
                        throw Object.assign(new Error(options.controlThrows.message), {code: options.controlThrows.code});
                    }
                    if (options.controlResult) {return options.controlResult(input);}
                    return makeResult({text: 'controlled'});
                },
            },
        };
    };
    const manager = createSessionManager({
        runner: {
            run: async () => {
                stats.runCalls += 1;
                const pause = options.pause ?? approvalPause();
                return paused(pause, pause.reason !== 'failure' && options.withContinuation !== false);
            },
        },
        ...(options.interactionPolicy ? {interactionPolicy: options.interactionPolicy} : {}),
    });
    return {manager, stats, controlInputs};
};

const controlOnlyPause = (continuationId = 'cont-ctl'): AgentProgramPause => ({
    reason: 'barrier',
    continuationId,
    stepName: 'browser.fill',
    risk: 'unknown',
});

const onlyPending = (manager: ReturnType<typeof makeHarness>['manager'], sessionId: string) =>
    manager.listInteractions(sessionId)!.filter((record) => record.status === 'pending');

test('an irreversible approval barrier exposes a pending interaction with typed sanitized payload', async () => {
    const {manager} = makeHarness();
    await manager.run(makeRequest());

    const [session] = manager.list();
    assert.equal(session.state, 'paused');
    assert.equal(session.resumable, true);
    assert.equal(session.interactions.length, 1);
    assert.equal(session.interactions[0].status, 'pending');
    assert.equal(session.interactions[0].kind, 'approval');

    const pending = onlyPending(manager, session.sessionId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].revision, 0);
    assert.equal(pending[0].payload.kind, 'approval');
    if (pending[0].payload.kind === 'approval') {
        assert.equal(pending[0].payload.actionName, 'browser.submit');
        assert.equal(pending[0].payload.risk, 'irreversible');
    }
    const serialized = JSON.stringify(pending[0]);
    assert.equal(serialized.includes('do-not-leak'), false);
    assert.equal(serialized.includes('output s = input.secret'), false);
});

test('approve resumes the same retained run once and completes without a second runner call', async () => {
    const {manager, stats} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');

    assert.equal(decided!.interaction.status, 'approved');
    assert.equal(decided!.interaction.decision?.kind, 'approve');
    assert.equal(decided!.session.state, 'completed');
    assert.equal(decided!.session.result?.text, 'resumed');
    assert.equal(stats.runCalls, 1);
    assert.equal(stats.resumeCalls, 1);
    assert.equal(stats.controlCalls, 0);

    const replayed = await manager.approveInteraction(session.sessionId, interaction.id, decided!.interaction.revision, 'ops-1');
    assert.equal(replayed!.interaction.revision, decided!.interaction.revision);
    assert.equal(stats.resumeCalls, 1);
    assert.equal(stats.runCalls, 1);
});

test('approved interactions survive ordinary session listing and status reads', async () => {
    const {manager} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];
    await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');

    const listed = manager.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].state, 'completed');
    assert.equal(listed[0].interactions.length, 1);
    assert.equal(listed[0].interactions[0].id, interaction.id);
    assert.equal(listed[0].interactions[0].status, 'approved');

    const fetched = manager.getInteraction(session.sessionId, interaction.id);
    assert.equal(fetched?.status, 'approved');
    assert.equal(fetched?.decision?.kind, 'approve');
});

test('approve with a stale revision is rejected with a concurrency error and resumes nothing', async () => {
    const {manager, stats} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    await assert.rejects(
        () => manager.approveInteraction(session.sessionId, interaction.id, interaction.revision - 1, 'ops-1'),
        (error: unknown) => error instanceof InteractionConcurrencyError && error.code === 'ERR_INTERACTION_CONCURRENCY',
    );
    assert.equal(stats.resumeCalls, 0);
    assert.equal(manager.status(session.sessionId)?.state, 'paused');
    assert.equal(onlyPending(manager, session.sessionId).length, 1);
});

test('approve and get reject an interaction bound to another session', async () => {
    const pausedResult = makeResult({programs: [pausedProgram(approvalPause())]});
    const manager = createSessionManager({
        runner: {
            run: async (request) => request.prompt === 'first'
                ? makeResult({text: 'done'})
                : {...pausedResult, continuation: {resume: async () => makeResult({text: 'resumed'})}, control: {control: async () => makeResult({text: 'controlled'})}},
        },
    });
    const stats = {resumeCalls: 0, controlCalls: 0};
    manager;
    void stats;
    await manager.run(makeRequest({prompt: 'first'}));
    await manager.run(makeRequest({prompt: 'second'}));
    const sessions = manager.list();
    assert.equal(sessions.length, 2);
    const interaction = onlyPending(manager, sessions[1].sessionId)[0];
    assert.ok(interaction, 'the paused second session must expose the pending approval');

    const wrong = await manager.approveInteraction(sessions[0].sessionId, interaction.id, interaction.revision, 'ops-1');
    assert.equal(wrong, null);
    assert.equal(manager.getInteraction(sessions[0].sessionId, interaction.id), null);
    assert.equal(manager.status(sessions[0].sessionId)?.state, 'completed');
    assert.equal(manager.status(sessions[1].sessionId)?.state, 'paused');
    assert.equal(onlyPending(manager, sessions[1].sessionId).length, 1);
});

test('deny never cancels: it returns the denial to the same retained control loop', async () => {
    const {manager, stats, controlInputs} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.denyInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-2', 'not safe', 'route to review');

    assert.equal(decided!.interaction.status, 'denied');
    assert.equal(decided!.interaction.decision?.kind, 'deny');
    assert.notEqual(decided!.session.state, 'cancelled', 'deny must never cancel the task');
    assert.notEqual(decided!.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
    assert.equal(stats.runCalls, 1, 'deny must not start a second runner');
    assert.equal(stats.resumeCalls, 0, 'deny must not take the approval execution fast path');
    assert.equal(stats.controlCalls, 1, 'deny must re-enter the same Agent control loop');
    assert.deepEqual(controlInputs[0], {
        kind: 'deny',
        effectName: 'browser.submit',
        reason: 'not safe',
        requestedAlternative: 'route to review',
    });
    assert.equal(decided!.session.state, 'completed', 'the control loop resumed the same task after denial');
});

test('deny without a control continuation fails truthfully instead of cancelling', async () => {
    const {manager} = makeHarness({withContinuation: false});
    await manager.run(makeRequest());
    const [session] = manager.list();
    assert.equal(session.resumable, false);
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.denyInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-2', 'not safe');
    assert.equal(decided!.interaction.status, 'denied');
    assert.equal(decided!.session.state, 'paused');
    assert.notEqual(decided!.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
});

test('without a retained continuation approve stays paused and is explicitly non-resumable', async () => {
    const {manager} = makeHarness({withContinuation: false});
    await manager.run(makeRequest());
    const [session] = manager.list();
    assert.equal(session.resumable, false);
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');
    assert.equal(decided!.interaction.status, 'approved');
    assert.equal(decided!.session.state, 'paused');
    assert.equal(decided!.session.resumable, false);
});

test('a failure pause produces no approval interaction and is not resumable', async () => {
    const {manager} = makeHarness({
        pause: {reason: 'failure', continuationId: 'cont-fail', failure: {code: 'ERR_DSL_RUNTIME', message: 'boom'}},
    });
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'paused');
    assert.equal(session.resumable, false);
    assert.deepEqual(session.interactions, []);
    assert.equal(manager.listInteractions(session.sessionId)!.length, 0);
});

test('unknown-risk commit barriers expose a pending approval instead of becoming orphan pauses', async () => {
    const {manager, stats} = makeHarness({pause: {reason: 'barrier', continuationId: 'cont-u', stepName: 'browser.fill', risk: 'unknown'}});
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'paused');
    assert.equal(session.resumable, true);
    assert.equal(session.interactions.length, 1);
    const pending = onlyPending(manager, session.sessionId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].payload.kind, 'approval');
    if (pending[0].payload.kind === 'approval') {
        assert.equal(pending[0].payload.actionName, 'browser.fill');
        assert.equal(pending[0].payload.risk, 'unknown');
    }
    assert.equal(stats.resumeCalls, 0);
});

test('session cancel cancels pending interactions and terminates a paused session', async () => {
    const {manager} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();

    const cancelled = manager.cancel(session.sessionId);

    assert.equal(cancelled?.state, 'cancelled');
    assert.equal(cancelled?.error?.code, 'ERR_SESSION_CANCELLED');
    assert.equal(cancelled?.interactions[0].status, 'cancelled');
    assert.equal(onlyPending(manager, session.sessionId).length, 0);
    assert.equal(manager.activityReservation().owner, 'none', 'cancellation releases the workspace reservation');
});

test('interaction cancel removes the pending request without touching the session run', async () => {
    const {manager, stats} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = manager.cancelInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-3');

    assert.equal(decided!.interaction.status, 'cancelled');
    assert.equal(decided!.session.state, 'paused');
    assert.equal(stats.resumeCalls, 0);
});

test('all commit-barrier programs become pending approvals while failure pauses do not', async () => {
    const {manager, stats} = makeHarness();
    const multi: AgentRunResult = {
        ...makeResult(),
        programs: [
            pausedProgram(approvalPause('cont-0')),
            {source: 'b', input: {}, status: 'paused', pause: {reason: 'barrier', continuationId: 'cont-u', stepName: 'browser.fill', risk: 'unknown'}},
            {source: 'c', input: {}, status: 'paused', pause: {reason: 'failure', continuationId: 'cont-f', failure: {code: 'ERR_X', message: 'x'}}},
        ],
        continuation: {
            resume: async () => {
                stats.resumeCalls += 1;
                return makeResult({text: 'resumed'});
            },
        },
    };
    const manager2 = createSessionManager({runner: {run: async () => multi}});
    await manager2.run(makeRequest());
    const [session] = manager2.list();

    const pending = onlyPending(manager2, session.sessionId);
    assert.equal(pending.length, 2);
    assert.deepEqual(pending.map((record) => record.internal?.programIndex), [0, 1]);
    assert.deepEqual(pending.map((record) => record.payload.kind === 'approval' ? record.payload.risk : null), [
        'irreversible',
        'unknown',
    ]);

    await manager2.approveInteraction(session.sessionId, pending[0].id, pending[0].revision, 'ops-1');
    assert.equal(manager2.status(session.sessionId)?.state, 'paused', 'another pending barrier keeps the run paused');
    assert.equal(stats.resumeCalls, 0);
    await manager2.approveInteraction(session.sessionId, pending[1].id, pending[1].revision, 'ops-1');
    assert.equal(manager2.status(session.sessionId)?.state, 'completed');
    assert.equal(stats.resumeCalls, 1);
});

test('headless policy blocks approval-required commit barriers without pending interactions', async () => {
    const {manager} = makeHarness({
        pause: {reason: 'barrier', continuationId: 'cont-u', stepName: 'browser.fill', risk: 'unknown'},
        interactionPolicy: 'headless',
    });
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'cancelled');
    assert.equal(session.error?.code, 'ERR_SESSION_INTERACTION_BLOCKED');
    assert.deepEqual(session.interactions, []);
    assert.equal(manager.listInteractions(session.sessionId)!.length, 0);
    assert.equal(manager.status(session.sessionId)?.resumable, false);
});

test('headless policy leaves non-approval pauses alone', async () => {
    const {manager} = makeHarness({
        pause: {reason: 'failure', continuationId: 'cont-f', failure: {code: 'ERR_DSL_RUNTIME', message: 'boom'}},
        interactionPolicy: 'headless',
    });
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'paused');
    assert.deepEqual(session.interactions, []);
    assert.equal(session.resumable, false);
});

test('continuation failure settles the session as failed with the continuation error code', async () => {
    const {manager, stats} = makeHarness({resumeThrows: {code: 'ERR_BOOM', message: 'boom'}});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');

    const settled = manager.status(session.sessionId);
    assert.equal(settled?.state, 'failed');
    assert.equal(settled?.error?.code, 'ERR_BOOM');
    assert.equal(stats.runCalls, 1);
});

test('control re-entry failure settles the session as failed without cancelling', async () => {
    const {manager, stats} = makeHarness({controlThrows: {code: 'ERR_CONTROL', message: 'control boom'}});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.denyInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-2', 'not safe');

    assert.equal(decided!.interaction.status, 'denied');
    assert.equal(manager.status(session.sessionId)?.state, 'failed');
    assert.equal(manager.status(session.sessionId)?.error?.code, 'ERR_CONTROL');
    assert.equal(stats.controlCalls, 1);
    assert.equal(stats.runCalls, 1);
});

test('a re-paused continuation creates a fresh pending interaction for the same run', async () => {
    const {manager, stats} = makeHarness({resumeAgainPause: approvalPause('cont-2')});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const first = onlyPending(manager, session.sessionId)[0];
    await manager.approveInteraction(session.sessionId, first.id, first.revision, 'ops-1');

    assert.equal(manager.status(session.sessionId)?.state, 'paused');
    const renewed = onlyPending(manager, session.sessionId);
    assert.equal(renewed.length, 1);
    assert.equal(renewed[0].id !== first.id, true);

    await manager.approveInteraction(session.sessionId, renewed[0].id, renewed[0].revision, 'ops-1');
    assert.equal(manager.status(session.sessionId)?.state, 'completed');
    assert.equal(stats.resumeCalls, 2);
});

const clarificationRequest: ModelRequestedInteraction = {
    kind: 'clarification',
    question: 'Which delivery date?',
    schema: {field: 'date', type: 'date'},
};

const recoveryRequest: ModelRequestedInteraction = {
    kind: 'recovery_decision',
    failureSummary: 'step failed',
    options: [
        {id: 'retry', kind: 'retry', label: 'Retry', eligible: true},
        {id: 'rollback', kind: 'rollback', label: 'Rollback', eligible: false, block: {code: 'no_recovery_point', message: 'no anchor'}},
    ],
};

const manualTakeoverRequest: ModelRequestedInteraction = {
    kind: 'takeover',
    reason: '2FA required',
    scope: 'workspace',
    guidanceModes: ['manual', 'teach'],
};

test('a retained run request is consumed into a real pending interaction automatically', async () => {
    const {manager} = makeHarness({requestedInteraction: clarificationRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'paused');
    const pending = onlyPending(manager, session.sessionId);
    assert.equal(pending.length, 1, 'the model-requested clarification must be auto-consumed');
    assert.equal(pending[0].payload.kind, 'clarification');
    assert.equal(pending[0].status, 'pending');
});

test('a model-requested clarification yields the same paused session with a single card', async () => {
    const {manager, stats} = makeHarness({
        requestedInteraction: clarificationRequest,
        pause: approvalPause(),
    });
    await manager.run(makeRequest());
    const [session] = manager.list();

    const pending = onlyPending(manager, session.sessionId);
    assert.equal(pending.length, 1, 'requesting control must not also create a barrier approval');
    assert.equal(pending[0].payload.kind, 'clarification');
    assert.equal(stats.runCalls, 1);
});

test('headless policy blocks a model-requested interaction instead of leaving an unanswerable wait', async () => {
    const {manager} = makeHarness({requestedInteraction: clarificationRequest, interactionPolicy: 'headless'});
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'cancelled');
    assert.equal(session.error?.code, 'ERR_SESSION_INTERACTION_BLOCKED');
    assert.deepEqual(session.interactions, [], 'no pending interaction is left behind under headless');
    assert.equal(manager.activityReservation().owner, 'none');
});

test('clarification answer returns through the same Agent control loop', async () => {
    const {manager, stats, controlInputs} = makeHarness({requestedInteraction: clarificationRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];
    assert.equal(posted.payload.kind, 'clarification');

    const decided = await manager.answerInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', '2026-09-01');
    assert.equal(decided!.interaction.status, 'answered');
    assert.equal(stats.controlCalls, 1);
    assert.deepEqual(controlInputs[0], {kind: 'clarification-answer', question: 'Which delivery date?', answer: '2026-09-01'});
    assert.equal(stats.runCalls, 1);
});

test('an invalid clarification answer keeps the interaction pending and the task waiting', async () => {
    const {manager, stats} = makeHarness({requestedInteraction: clarificationRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];

    await assert.rejects(
        () => manager.answerInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'not-a-date'),
        (error: unknown) => error instanceof Error && (error as Error & {code?: string}).code === 'ERR_INTERACTION_VALIDATION',
    );
    assert.equal(stats.controlCalls, 0);
    assert.equal(onlyPending(manager, session.sessionId).length, 1, 'the interaction must stay pending');
});

test('recovery choice returns through the same Agent control loop and rejects ineligible options', async () => {
    const {manager, stats, controlInputs} = makeHarness({requestedInteraction: recoveryRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];
    assert.equal(posted.payload.kind, 'recovery_decision');

    await assert.rejects(
        () => manager.chooseRecoveryInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'rollback'),
        (error: unknown) => error instanceof Error && (error as Error & {code?: string}).code === 'ERR_INTERACTION_VALIDATION',
    );

    const decided = await manager.chooseRecoveryInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'retry');
    assert.equal(decided!.interaction.status, 'resolved');
    assert.equal(stats.controlCalls, 1);
    assert.deepEqual(controlInputs[0], {kind: 'recovery-choice', optionId: 'retry', optionLabel: 'Retry'});
});

test('takeover begin guidance does not resolve the interaction and marks human control', async () => {
    const {manager, stats} = makeHarness({requestedInteraction: manualTakeoverRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];
    assert.equal(posted.payload.kind, 'takeover');
    assert.equal(posted.stage, 'offered');

    const active = manager.beginGuidanceInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'manual');
    assert.equal(active!.interaction.status, 'pending');
    assert.equal(active!.interaction.stage, 'active');
    assert.equal(stats.controlCalls, 0, 'beginning guidance must not resolve the interaction');
    const reservation = manager.activityReservation();
    assert.equal(reservation.owner, 'task');
    assert.equal(reservation.humanControl, 'manual');
    assert.equal(manager.status(session.sessionId)?.state, 'paused', 'takeover active keeps the task waiting');
});

test('return control resolves the takeover and re-enters the Agent control loop', async () => {
    const {manager, stats, controlInputs} = makeHarness({requestedInteraction: manualTakeoverRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];
    manager.beginGuidanceInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'manual');

    const resolved = await manager.returnControlInteraction(session.sessionId, posted.id, posted.revision + 1, 'ops-1', 'manual');
    assert.equal(resolved!.interaction.status, 'resolved');
    assert.equal(stats.controlCalls, 1);
    assert.deepEqual(controlInputs[0], {kind: 'takeover-return'});
    assert.equal(manager.activityReservation().humanControl, 'none', 'return control clears human control');
    assert.equal(manager.status(session.sessionId)?.state, 'completed');
});

test('a takeover active interaction cannot be resolved by an approval-style decision', async () => {
    const {manager} = makeHarness({requestedInteraction: manualTakeoverRequest});
    await manager.run(makeRequest());
    const [session] = manager.list();
    const posted = onlyPending(manager, session.sessionId)[0];
    manager.beginGuidanceInteraction(session.sessionId, posted.id, posted.revision, 'ops-1', 'manual');
    await assert.rejects(
        () => manager.approveInteraction(session.sessionId, posted.id, posted.revision + 1, 'ops-1'),
        (error: unknown) => error instanceof Error && (error as Error & {code?: string}).code === 'ERR_INTERACTION_VALIDATION',
    );
});

test('stale interaction expiry prevents the irreversible effect from crossing', async () => {
    let now = 1000;
    const manager = createSessionManager({
        runner: {
            run: async () => {
                const base = makeResult({programs: [pausedProgram(approvalPause())]});
                return {...base, continuation: {resume: async () => makeResult({text: 'resumed'})}};
            },
        },
        now: () => now,
        interactionTtlMs: 100,
    });
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];
    now = 1200;
    const expired = await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');
    assert.equal(expired!.interaction.status, 'expired', 'a late approval must expire instead of crossing the barrier');
    assert.equal(manager.status(session.sessionId)?.state, 'paused');
    assert.equal(manager.expireStale(session.sessionId), 0, 'already expired');
    assert.equal(manager.sweepOrphans(), 1, 'the orphaned pause becomes failed, not waiting');
    assert.equal(manager.status(session.sessionId)?.state, 'failed');
    assert.equal(manager.status(session.sessionId)?.error?.code, 'ERR_ORPHAN_PAUSE');
});

test('an orphan pause sweeps to failed and releases the reservation, never waiting', async () => {
    const {manager} = makeHarness({withContinuation: false});
    await manager.run(makeRequest());
    const [session] = manager.list();
    assert.equal(session.state, 'paused');
    assert.equal(session.interactions.length, 1);
    manager.cancelInteraction(session.sessionId, session.interactions[0].id, session.interactions[0].revision, 'ops-1');
    assert.equal(onlyPending(manager, session.sessionId).length, 0);

    assert.equal(manager.sweepOrphans(), 1);
    const after = manager.status(session.sessionId)!;
    assert.equal(after.state, 'failed');
    assert.equal(after.error?.code, 'ERR_ORPHAN_PAUSE');
    assert.equal(manager.activityReservation().owner, 'none');
});

test('a second task cannot start while the workspace reservation is held', async () => {
    const never = new Promise<AgentRunResult>(() => {});
    const manager = createSessionManager({runner: {run: () => never}});
    const snapshot = manager.start(makeRequest({prompt: 'first'}));
    assert.equal(snapshot.state, 'running');
    assert.equal(manager.activityReservation().owner, 'task');
    assert.throws(
        () => manager.start(makeRequest({prompt: 'second'})),
        ActivityConflictError,
    );
    assert.equal(manager.list().length, 1, 'the conflicted start must not create a session');
});

test('unknown session lookups return null and decided interactions reject further decisions', async () => {
    const {manager} = makeHarness();
    assert.equal(manager.listInteractions('missing'), null);
    assert.equal(manager.getInteraction('missing', 'any'), null);

    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];
    await manager.approveInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-1');

    await assert.rejects(
        () => manager.denyInteraction(session.sessionId, interaction.id, interaction.revision + 1, 'ops-2', 'late'),
        (error: unknown) => error instanceof InteractionStateError && error.code === 'ERR_INTERACTION_STATE',
    );
});