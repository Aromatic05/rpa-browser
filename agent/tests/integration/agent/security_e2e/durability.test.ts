import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildSecurityHarness,
    buildSecurityWorkspace,
    countingResolver,
    SECURITY_CANARY,
    apiTokenRefString,
    REVERSIBLE_SOURCE,
    IRREVERSIBLE_SOURCE,
    scanForString,
    mkdtempDir,
} from '../../../helpers/agent_security_composition';

const completeRun = async (baseUrl: string, provider: string, model: string): Promise<string> => {
    const run = await fetch(`${baseUrl}/agent`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            prompt: 'complete the reversible fill',
            provider,
            model,
            source: REVERSIBLE_SOURCE,
            input: {value: apiTokenRefString(), done: true},
        }),
    });
    assert.equal(run.status, 200);
    return run.headers.get('x-session-id')!;
};

const pauseRun = async (baseUrl: string, provider: string, model: string): Promise<string> => {
    const run = await fetch(`${baseUrl}/agent`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({
            prompt: 'pause at the irreversible barrier',
            provider,
            model,
            source: IRREVERSIBLE_SOURCE,
            input: {done: true},
        }),
    });
    assert.equal(run.status, 200);
    return run.headers.get('x-session-id')!;
};

const cancelRun = async (baseUrl: string, provider: string, model: string): Promise<string> => {
    const sessionId = await pauseRun(baseUrl, provider, model);
    const cancelled = await fetch(`${baseUrl}/agent/sessions/${sessionId}/cancel`, {method: 'POST'});
    assert.equal(cancelled.status, 200);
    return sessionId;
};

const restartOn = async (dataDir: string) => {
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30800,
        interaction: 'interactive',
        credentialResolver: countingResolver([]),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    return {harness, port, calls};
};

test('a completed durable session and its report survive a service restart with no raw secret', async () => {
    const dataDir = mkdtempDir('agent-sec-durable-completed-');
    const first = await buildSecurityHarness({
        portBegin: 30800,
        credentialResolver: countingResolver([]),
        dataDir,
        interaction: 'interactive',
    });
    const firstPort = await first.start();
    const sessionId = await completeRun(
        `http://127.0.0.1:${String(firstPort)}`,
        first.provider,
        first.model,
    );
    await first.stop();

    const second = await restartOn(dataDir);
    try {
        const baseUrl = `http://127.0.0.1:${String(second.port)}`;
        const recovered = await (await fetch(`${baseUrl}/agent/sessions/${sessionId}`)).json() as {
            state: string;
            reportAvailable: boolean;
            resumable: boolean;
        };
        assert.equal(recovered.state, 'completed');
        assert.equal(recovered.reportAvailable, true);
        assert.equal(recovered.resumable, false);

        const report = await fetch(`${baseUrl}/agent/sessions/${sessionId}/report`);
        assert.equal(report.status, 200);
        const reportText = await report.text();
        assert.ok(reportText.includes('"status":"completed"'));
        assert.ok(!reportText.includes(SECURITY_CANARY), 'the recovered report must not contain the resolved secret');

        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), [], 'stored files must never contain the raw secret');
    } finally {
        await second.harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('a cancelled durable session survives a service restart with no raw secret', async () => {
    const dataDir = mkdtempDir('agent-sec-durable-cancelled-');
    const first = await buildSecurityHarness({
        portBegin: 30800,
        credentialResolver: countingResolver([]),
        dataDir,
        interaction: 'interactive',
    });
    const firstPort = await first.start();
    const sessionId = await cancelRun(
        `http://127.0.0.1:${String(firstPort)}`,
        first.provider,
        first.model,
    );
    await first.stop();

    const second = await restartOn(dataDir);
    try {
        const baseUrl = `http://127.0.0.1:${String(second.port)}`;
        const recovered = await (await fetch(`${baseUrl}/agent/sessions/${sessionId}`)).json() as {
            state: string;
            error: {code: string} | null;
        };
        assert.equal(recovered.state, 'cancelled');
        assert.equal(recovered.error?.code, 'ERR_SESSION_CANCELLED');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), [], 'the cancelled session must leave no secret on disk');
    } finally {
        await second.harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('a paused durable approval barrier is restored and resumes exactly once after service restart', async () => {
    const dataDir = mkdtempDir('agent-sec-durable-paused-');
    const first = await buildSecurityHarness({
        portBegin: 30800,
        credentialResolver: countingResolver([]),
        dataDir,
        interaction: 'interactive',
    });
    const firstPort = await first.start();
    const sessionId = await pauseRun(
        `http://127.0.0.1:${String(firstPort)}`,
        first.provider,
        first.model,
    );
    const before = await (await fetch(`http://127.0.0.1:${String(firstPort)}/agent/sessions/${sessionId}`)).json() as {resumable: boolean};
    assert.equal(before.resumable, true, 'the live paused session must be resumable before restart');
    await first.stop();

    const second = await restartOn(dataDir);
    try {
        const baseUrl = `http://127.0.0.1:${String(second.port)}`;
        const recovered = await (await fetch(`${baseUrl}/agent/sessions/${sessionId}`)).json() as {
            state: string;
            resumable: boolean;
            interactions: unknown[];
        };
        assert.equal(recovered.state, 'paused');
        assert.equal(recovered.resumable, true, 'a durable approval barrier remains resumable after restart');

        const listed = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`);
        const interactions = (await listed.json() as {interactions: Array<{id: string; revision: number; kind: string; status: string}>}).interactions;
        assert.equal(interactions.length, 1);
        assert.equal(interactions[0].kind, 'approval');
        assert.equal(interactions[0].status, 'pending');

        const approve = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/${interactions[0].id}/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: interactions[0].revision, approvedBy: 'ops-1'}),
        });
        assert.equal(approve.status, 200);
        const approved = await approve.json() as {session: {state: string}};
        assert.equal(approved.session.state, 'completed');
        assert.deepEqual(second.calls, [{name: 'browser.click', args: {nodeId: 'secret-field'}}],
            'restored approval must cross the retained barrier exactly once');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await second.harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});