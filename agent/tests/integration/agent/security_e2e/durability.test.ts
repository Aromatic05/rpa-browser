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

const denyRun = async (baseUrl: string, provider: string, model: string): Promise<string> => {
    const sessionId = await pauseRun(baseUrl, provider, model);
    const listed = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`);
    const interaction = ((await listed.json() as {interactions: Array<{id: string; revision: number}>}).interactions)[0];
    const denied = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2', reason: 'not safe'}),
    });
    assert.equal(denied.status, 200);
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
    const sessionId = await denyRun(
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
        assert.equal(recovered.error?.code, 'ERR_SESSION_INTERACTION_DENIED');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), [], 'the cancelled session must leave no secret on disk');
    } finally {
        await second.harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('a paused durable session is explicitly non-resumable after a service restart', async () => {
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
        assert.equal(recovered.resumable, false, 'paused sessions must be explicitly non-resumable after restart');
        assert.deepEqual(recovered.interactions, [], 'the retained interactions must not resurrect across a restart');

        const listed = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions`);
        assert.deepEqual((await listed.json() as {interactions: unknown[]}).interactions, []);

        const approve = await fetch(`${baseUrl}/agent/sessions/${sessionId}/interactions/any/approve`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({revision: 0, approvedBy: 'ops-1'}),
        });
        assert.equal(approve.status, 404, 'no retained transaction may resume across the restart boundary');
        assert.deepEqual(second.calls, [], 'no effect may execute across the restart boundary');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await second.harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});