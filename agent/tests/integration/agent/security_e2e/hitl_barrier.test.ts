import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildSecurityHarness,
    buildSecurityWorkspace,
    countingResolver,
    SECURITY_CANARY,
    apiTokenRefString,
    IRREVERSIBLE_SOURCE,
    scanForString,
    mkdtempDir,
    withBearer,
} from '../../../helpers/agent_security_composition';

type Interaction = {
    id: string;
    kind: string;
    status: string;
    revision: number;
    payload: {kind: 'approval'; actionName?: string; summary: string; risk: string};
};

const hitlBody = (provider: string, model: string) => ({
    prompt: 'approve the irreversible effect',
    provider,
    model,
    source: IRREVERSIBLE_SOURCE,
    input: {done: true},
});

const startPausedRun = async (baseUrl: string, provider: string, model: string): Promise<string> => {
    const run = await fetch(`${baseUrl}/agent`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(hitlBody(provider, model)),
    });
    assert.equal(run.status, 200);
    return run.headers.get('x-session-id')!;
};

test('interactive mode creates a sanitized pending interaction and approve resumes the same retained transaction exactly once', async () => {
    const dataDir = mkdtempDir('agent-sec-hitl-approve-');
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30700,
        interaction: 'interactive',
        credentialResolver: countingResolver([]),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    let sessionId = '';
    try {
        const run = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(hitlBody(harness.provider, harness.model)),
        });
        sessionId = run.headers.get('x-session-id')!;
        const runText = await run.text();
        assert.ok(!runText.includes(SECURITY_CANARY));
        assert.ok(runText.includes('"risk":"irreversible"'), 'the paused run must expose the irreversible risk');
        assert.deepEqual(calls, [], 'the irreversible effect must not run before approval');

        const listed = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`, {headers: withBearer(undefined)});
        assert.equal(listed.status, 200);
        const listedBody = await listed.json() as {interactions: Interaction[]};
        assert.equal(listedBody.interactions.length, 1);
        const interaction = listedBody.interactions[0];
        assert.equal(interaction.kind, 'approval');
        assert.equal(interaction.status, 'pending');
        assert.equal(interaction.payload.actionName, 'browser.click');
        assert.ok(!JSON.stringify(interaction).includes(SECURITY_CANARY), 'interaction evidence must be sanitized');
        assert.ok(!JSON.stringify(interaction).includes(apiTokenRefString()));

        const stale = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision + 1, approvedBy: 'ops-1'}),
        });
        assert.equal(stale.status, 409);
        assert.equal((await stale.json() as {code: string}).code, 'ERR_INTERACTION_CONCURRENCY');
        assert.deepEqual(calls, [], 'a stale approve must not cross the barrier');

        const approved = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
        });
        assert.equal(approved.status, 200);
        const decision = await approved.json() as {interaction: {status: string}; session: {state: string}};
        assert.equal(decision.interaction.status, 'approved');
        assert.equal(decision.session.state, 'completed');
        assert.deepEqual(calls, [{name: 'browser.click', args: {nodeId: 'secret-field'}}], 'approval crosses the barrier and executes the effect exactly once');

        const report = await fetch(`${baseUrl}/agent/sessions/${sessionId}/report`);
        assert.equal(report.status, 200);
        assert.ok(!(await report.text()).includes(SECURITY_CANARY));
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), [], 'no stored file may hold the secret after the approved run');
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('interactive deny never cancels and never executes the irreversible effect', async () => {
    const dataDir = mkdtempDir('agent-sec-hitl-deny-');
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30700,
        interaction: 'interactive',
        credentialResolver: countingResolver([]),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    let sessionId = '';
    try {
        sessionId = await startPausedRun(baseUrl, harness.provider, harness.model);
        const listed = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`);
        const interaction = ((await listed.json() as {interactions: Interaction[]}).interactions)[0];

        const denied = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2', reason: 'not safe'}),
        });
        assert.equal(denied.status, 200);
        const decision = await denied.json() as {interaction: {status: string}; session: {state: string; error: {code: string; message: string} | null}};
        assert.equal(decision.interaction.status, 'denied');
        assert.notEqual(decision.session.state, 'cancelled', 'deny must never cancel the task');
        assert.notEqual(decision.session.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
        assert.deepEqual(calls, [], 'denial must never execute the irreversible effect');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('headless policy blocks the irreversible effect deterministically with no pending interaction', async () => {
    const dataDir = mkdtempDir('agent-sec-hitl-headless-');
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30700,
        interaction: 'headless',
        credentialResolver: countingResolver([]),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    try {
        const run = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(hitlBody(harness.provider, harness.model)),
        });
        assert.equal(run.status, 200);
        const sessionId = run.headers.get('x-session-id')!;
        const runText = await run.text();
        assert.ok(!runText.includes(SECURITY_CANARY));

        const snapshot = await (await fetch(`${baseUrl}/agent/sessions/${sessionId}`)).json() as {
            state: string;
            error: {code: string; message: string} | null;
            interactions: unknown[];
        };
        assert.equal(snapshot.state, 'cancelled');
        assert.equal(snapshot.error?.code, 'ERR_SESSION_INTERACTION_BLOCKED');
        assert.deepEqual(snapshot.interactions, []);

        const listed = await (await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`)).json() as {interactions: unknown[]};
        assert.deepEqual(listed.interactions, [], 'headless must never leave a pending interaction');
        assert.deepEqual(calls, [], 'headless must block the irreversible effect deterministically');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('wrong-session decisions and foreign interaction lookups fail closed', async () => {
    const dataDir = mkdtempDir('agent-sec-hitl-wrong-');
    const harness = await buildSecurityHarness({
        portBegin: 30700,
        interaction: 'interactive',
        credentialResolver: countingResolver([]),
        dataDir,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    try {
        const first = await startPausedRun(baseUrl, harness.provider, harness.model);
        const listed = await fetch(`${baseUrl}/agent/sessions/${first}/interactions`);
        const interaction = ((await listed.json() as {interactions: Interaction[]}).interactions)[0];
        // Stop the first task (releasing the workspace reservation) so a second
        // task can pause with its own interaction.
        const stopped = await fetch(`${baseUrl}/agent/sessions/${first}/cancel`, {method: 'POST'});
        assert.equal(stopped.status, 200);
        const second = await startPausedRun(baseUrl, harness.provider, harness.model);

        const foreign = await fetch(`${baseUrl}/agent/sessions/${second}/interactions/${interaction.id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
        });
        assert.equal(foreign.status, 404);

        const getForeign = await fetch(`${baseUrl}/agent/sessions/${second}/interactions/${interaction.id}`);
        assert.equal(getForeign.status, 404);

        const missing = await fetch(`${baseUrl}/agent/sessions/missing/interactions`);
        assert.equal(missing.status, 404);

        const firstStill = await (await fetch(`${baseUrl}/agent/sessions/${first}`)).json() as {state: string};
        assert.equal(firstStill.state, 'cancelled');
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});