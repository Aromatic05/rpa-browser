import test from 'node:test';
import assert from 'node:assert/strict';
import {
    InteractionConcurrencyError,
    InteractionStateError,
} from '../../../../../src/agent/interaction/contracts';
import {createSessionManager} from '../../../../../src/agent/service/session/manager';
import type {AgentProgramPause, AgentRunResult} from '../../../../../src/agent/execution/types';
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
    interactionPolicy?: 'interactive' | 'headless';
} = {}) => {
    const stats = {runCalls: 0, resumeCalls: 0};
    const paused = (pause: AgentProgramPause, continuation: boolean): AgentRunResult => {
        const base = makeResult({programs: [pausedProgram(pause)]});
        if (!continuation) {return base;}
        return {
            ...base,
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
    return {manager, stats};
};

const onlyPending = (manager: ReturnType<typeof makeHarness>['manager'], sessionId: string) =>
    manager.listInteractions(sessionId)!.filter((record) => record.status === 'pending');

test('an irreversible approval barrier exposes a pending interaction with sanitized evidence', async () => {
    const {manager} = makeHarness();
    await manager.run(makeRequest());

    const [session] = manager.list();
    assert.equal(session.state, 'paused');
    assert.equal(session.resumable, true);
    assert.equal(session.interactions.length, 1);
    assert.equal(session.interactions[0].status, 'pending');
    assert.equal(session.interactions[0].kind, 'irreversible-effect-approval');

    const pending = onlyPending(manager, session.sessionId);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].revision, 0);
    assert.equal(pending[0].evidence.effectName, 'browser.submit');
    assert.equal(pending[0].evidence.summary.includes('browser.submit'), true);
    const serialized = JSON.stringify(pending[0].evidence);
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
    const {manager, stats} = makeHarness();
    await manager.run(makeRequest({prompt: 'first'}));
    await manager.run(makeRequest({prompt: 'second'}));
    const sessions = manager.list();
    assert.equal(sessions.length, 2);
    const interaction = onlyPending(manager, sessions[0].sessionId)[0];

    const wrong = await manager.approveInteraction(sessions[1].sessionId, interaction.id, interaction.revision, 'ops-1');
    assert.equal(wrong, null);
    assert.equal(manager.getInteraction(sessions[1].sessionId, interaction.id), null);
    assert.equal(stats.resumeCalls, 0);
    assert.equal(manager.status(sessions[0].sessionId)?.state, 'paused');
    assert.equal(manager.status(sessions[1].sessionId)?.state, 'paused');
    assert.equal(onlyPending(manager, sessions[0].sessionId).length, 1);
});

test('deny marks the interaction denied and terminates the session as cancelled with a stable reason', async () => {
    const {manager, stats} = makeHarness();
    await manager.run(makeRequest());
    const [session] = manager.list();
    const interaction = onlyPending(manager, session.sessionId)[0];

    const decided = await manager.denyInteraction(session.sessionId, interaction.id, interaction.revision, 'ops-2', 'not safe');

    assert.equal(decided!.interaction.status, 'denied');
    assert.equal(decided!.interaction.decision?.kind, 'deny');
    assert.equal(decided!.session.state, 'cancelled');
    assert.equal(decided!.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
    assert.equal(decided!.session.error?.message.includes('not safe'), true);
    assert.equal(decided!.session.interactions[0].status, 'denied');
    assert.equal(stats.resumeCalls, 0);
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

test('non-irreversible pauses produce no approval interaction', async () => {
    const {manager, stats} = makeHarness({pause: {reason: 'barrier', continuationId: 'cont-u', stepName: 'browser.fill', risk: 'unknown'}});
    await manager.run(makeRequest());
    const [session] = manager.list();

    assert.equal(session.state, 'paused');
    assert.equal(session.resumable, true);
    assert.deepEqual(session.interactions, []);
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

test('only irreversible approval programs become pending interactions in a multi-program pause', async () => {
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
    assert.equal(pending.length, 1);
    assert.equal(pending[0].evidence.effectName, 'browser.submit');
    assert.equal(pending[0].evidence.tags?.includes('program:0'), true);

    await manager2.approveInteraction(session.sessionId, pending[0].id, pending[0].revision, 'ops-1');
    assert.equal(manager2.status(session.sessionId)?.state, 'completed');
    assert.equal(stats.resumeCalls, 1);
});

test('headless policy blocks approval-required irreversible effects without pending interactions', async () => {
    const {manager} = makeHarness({interactionPolicy: 'headless'});
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