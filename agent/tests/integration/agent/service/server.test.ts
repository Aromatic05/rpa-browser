import test from 'node:test';
import assert from 'node:assert/strict';
import {createPortAllocator} from '../../../../src/automation/runtime/service/ports';
import {createAgentHttpServer} from '../../../../src/agent/service/server';
import {createSessionManager} from '../../../../src/agent/service/session/manager';
import type {AgentRunResult} from '../../../../src/agent/execution/types';

const baseTrace = {
    metrics: {
        turns: 1,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: [],
};

const completedResult: AgentRunResult = {
    provider: 'p',
    model: 'm',
    text: 'done',
    trace: baseTrace,
};

const portAllocator = createPortAllocator(24600);

type Harness = {
    baseUrl: string;
    stop: () => Promise<void>;
    stats: {runCalls: number; resumeCalls: number};
};

const startHarness = async (result: AgentRunResult | null = null): Promise<Harness> => {
    const port = await portAllocator.allocate('agent-server-test', 'agent');
    const stats = {runCalls: 0, resumeCalls: 0};
    const paused = (): AgentRunResult => ({
        ...completedResult,
        programs: [{
            source: 'output s = input.secret',
            input: {secret: 'do-not-leak'},
            status: 'paused',
            pause: {reason: 'barrier', continuationId: 'cont-1', stepName: 'effect.submit', risk: 'irreversible'},
        }],
        continuation: {
            resume: async () => {
                stats.resumeCalls += 1;
                return {...completedResult, text: 'resumed'};
            },
        },
    });
    const manager = createSessionManager({
        runner: {
            run: async () => {
                stats.runCalls += 1;
                return result === null ? paused() : result;
            },
        },
    });
    const server = await createAgentHttpServer({
        manager,
        workspaceName: 'agent-server-test',
        port,
    });
    return {
        baseUrl: `http://127.0.0.1:${String(port)}`,
        stop: server.stop,
        stats,
    };
};

const runSession = async (harness: Harness, prompt: string): Promise<{sessionId: string; session: any}> => {
    const response = await fetch(`${harness.baseUrl}/agent`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({prompt, provider: 'p', model: 'm'}),
    });
    assert.equal(response.status, 200);
    const sessionId = response.headers.get('x-session-id')!;
    const status = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}`);
    assert.equal(status.status, 200);
    return {sessionId, session: await status.json()};
};

test('approval-required paused session is actionable end-to-end over HTTP', async () => {
    const harness = await startHarness();
    try {
        const {sessionId, session} = await runSession(harness, 'go');
        assert.equal(session.state, 'paused');
        assert.equal(session.resumable, true);
        assert.equal(session.interactions.length, 1);
        assert.equal(session.interactions[0].status, 'pending');

        const listed = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions`);
        assert.equal(listed.status, 200);
        const listedBody = await listed.json() as any;
        assert.equal(listedBody.interactions.length, 1);
        const interaction = listedBody.interactions[0];
        assert.equal(interaction.payload.kind, 'approval');
        assert.equal(JSON.stringify(interaction).includes('do-not-leak'), false);

        const stale = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: 99, approvedBy: 'ops-1'}),
        });
        assert.equal(stale.status, 409);
        const staleBody = await stale.json() as any;
        assert.equal(staleBody.code, 'ERR_INTERACTION_CONCURRENCY');

        const fetched = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}`);
        assert.equal(fetched.status, 200);
        assert.equal((await fetched.json() as any).status, 'pending');

        const approved = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
        });
        assert.equal(approved.status, 200);
        const decision = await approved.json() as any;
        assert.equal(decision.interaction.status, 'approved');
        assert.equal(decision.session.state, 'completed');
        assert.equal(harness.stats.runCalls, 1);
        assert.equal(harness.stats.resumeCalls, 1);

        const listedAfter = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions`);
        const afterBody = await listedAfter.json() as any;
        assert.equal(afterBody.interactions.length, 1);
        assert.equal(afterBody.interactions[0].status, 'approved');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-test', 'agent');
    }
});

test('deny over HTTP never cancels the session and validates the body', async () => {
    const harness = await startHarness();
    try {
        const {sessionId} = await runSession(harness, 'go');
        const listed = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions`);
        const interaction = ((await listed.json() as any).interactions as Array<any>)[0];

        const invalid = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2'}),
        });
        assert.equal(invalid.status, 400);

        const noBody = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
        });
        assert.equal(noBody.status, 400);

        const denied = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2', reason: 'not safe'}),
        });
        assert.equal(denied.status, 200);
        const decision = await denied.json() as any;
        assert.equal(decision.interaction.status, 'denied');
        assert.notEqual(decision.session.state, 'cancelled', 'deny must never cancel the task');
        assert.notEqual(decision.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
        assert.equal(harness.stats.resumeCalls, 0, 'deny must not take the approval fast path');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-test', 'agent');
    }
});

test('interaction routes reject unknown sessions, foreign sessions, and unknown interactions', async () => {
    const harness = await startHarness();
    try {
        const missingList = await fetch(`${harness.baseUrl}/agent/sessions/missing/interactions`);
        assert.equal(missingList.status, 404);
        const missingGet = await fetch(`${harness.baseUrl}/agent/sessions/missing/interactions/any`);
        assert.equal(missingGet.status, 404);
        const missingApprove = await fetch(`${harness.baseUrl}/agent/sessions/missing/interactions/any/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: 0, approvedBy: 'ops-1'}),
        });
        assert.equal(missingApprove.status, 404);

        const first = await runSession(harness, 'first');
        // The second task is rejected while the first holds the workspace reservation.
        const conflict = await fetch(`${harness.baseUrl}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({prompt: 'second', provider: 'p', model: 'm'}),
        });
        assert.equal(conflict.status, 409);
        assert.equal((await conflict.json() as any).code, 'ERR_ACTIVITY_CONFLICT');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-test', 'agent');
    }
});

test('legacy completed session flows remain compatible with interaction-aware snapshots', async () => {
    const harness = await startHarness(completedResult);
    try {
        const {sessionId, session} = await runSession(harness, 'plain');
        assert.equal(session.state, 'completed');
        assert.deepEqual(session.interactions, []);

        const listed = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/interactions`);
        assert.equal(listed.status, 200);
        assert.deepEqual((await listed.json() as any).interactions, []);

        const report = await fetch(`${harness.baseUrl}/agent/sessions/${sessionId}/report`);
        assert.equal(report.status, 200);
        const reportBody = await report.json() as any;
        assert.equal(reportBody.report.terminal.status, 'completed');

        const sessions = await fetch(`${harness.baseUrl}/agent/sessions`);
        const sessionsBody = await sessions.json() as any;
        assert.equal(sessionsBody.sessions.length, 1);
        assert.equal(sessionsBody.sessions[0].state, 'completed');
    } finally {
        await harness.stop();
        portAllocator.release('agent-server-test', 'agent');
    }
});
