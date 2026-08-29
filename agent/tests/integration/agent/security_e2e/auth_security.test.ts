import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildSecurityHarness,
    buildSecurityWorkspace,
    countingResolver,
    createAuthSecurity,
    SECURITY_CANARY,
    apiTokenRefString,
    REVERSIBLE_SOURCE,
    scanForString,
    withBearer,
    mkdtempDir,
} from '../../../helpers/agent_security_composition';

const TOKEN = 'agent-e2e-bearer-token-9f31';

const requestBody = (provider: string, model: string) => ({
    prompt: 'fill the secret form with the credential ref',
    provider,
    model,
    source: REVERSIBLE_SOURCE,
    input: {value: apiTokenRefString(), done: true},
});

test('auth-enabled real HTTP agent service rejects missing and wrong bearer without token echo', async () => {
    const dataDir = mkdtempDir('agent-sec-auth-');
    const harness = await buildSecurityHarness({
        portBegin: 30500,
        security: createAuthSecurity(TOKEN),
        credentialResolver: countingResolver([]),
        dataDir,
    });
    const port = await harness.start();
    const endpoint = `http://127.0.0.1:${String(port)}/agent`;
    const body = requestBody(harness.provider, harness.model);
    try {
        const missing = await fetch(endpoint, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify(body),
        });
        assert.equal(missing.status, 401);
        const missingText = await missing.text();
        assert.ok(!missingText.includes(TOKEN), 'auth failure must never echo the token');
        assert.ok(!missingText.includes(SECURITY_CANARY));

        const wrong = await fetch(endpoint, {
            method: 'POST',
            headers: {'content-type': 'application/json', authorization: 'Bearer wrong-token'},
            body: JSON.stringify(body),
        });
        assert.equal(wrong.status, 401);
        const wrongText = await wrong.text();
        assert.ok(!wrongText.includes(TOKEN));
        assert.ok(!wrongText.includes('wrong-token'), 'auth failure must not echo the presented token');

        const sessionList = await fetch(`${endpoint}/sessions`, {headers: withBearer('wrong-token')});
        assert.equal(sessionList.status, 401);
        assert.ok(!(await sessionList.text()).includes(TOKEN));

        const accepted = await fetch(endpoint, {
            method: 'POST',
            headers: withBearer(TOKEN),
            body: JSON.stringify(body),
        });
        assert.equal(accepted.status, 200);
        const acceptedText = await accepted.text();
        assert.ok(!acceptedText.includes(TOKEN), 'successful auth must not echo the token');
        assert.ok(!acceptedText.includes(SECURITY_CANARY), 'successful run must not echo the canary secret');
        const acceptedJson = JSON.parse(acceptedText) as {
            programs: Array<{status: string; input: Record<string, unknown>}>;
        };
        assert.deepEqual(acceptedJson.programs[0].input, {value: apiTokenRefString(), done: true});
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('correct bearer reaches session status, report and stored files with no canary and no token echo', async () => {
    const dataDir = mkdtempDir('agent-sec-auth-sweep-');
    const resolvedIds: string[] = [];
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30500,
        security: createAuthSecurity(TOKEN),
        credentialResolver: countingResolver(resolvedIds),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const body = requestBody(harness.provider, harness.model);
    let sessionId = '';
    try {
        const accepted = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: withBearer(TOKEN),
            body: JSON.stringify(body),
        });
        assert.equal(accepted.status, 200);
        sessionId = accepted.headers.get('x-session-id')!;
        assert.ok(sessionId.length > 0);

        const result = await accepted.json() as {
            programs?: Array<{status: string; input: Record<string, unknown>}>;
        };
        assert.equal(result.programs?.[0].status, 'completed');
        assert.deepEqual(result.programs?.[0].input, {value: apiTokenRefString(), done: true});

        const status = await fetch(`${baseUrl}/agent/sessions/${sessionId}`, {headers: withBearer(TOKEN)});
        assert.equal(status.status, 200);
        const statusText = await status.text();
        assert.ok(!statusText.includes(TOKEN));
        assert.ok(!statusText.includes(SECURITY_CANARY));

        const report = await fetch(`${baseUrl}/agent/sessions/${sessionId}/report`, {headers: withBearer(TOKEN)});
        assert.equal(report.status, 200);
        const reportText = await report.text();
        assert.ok(!reportText.includes(TOKEN));
        assert.ok(!reportText.includes(SECURITY_CANARY), 'report must stay free of the resolved secret');
        const reportJson = JSON.parse(reportText) as {report: {programs?: Array<{source: string; inputKeys: string[]}>}};
        assert.ok(reportJson.report.programs?.[0].source.includes('input.value'));
        assert.deepEqual(reportJson.report.programs?.[0].inputKeys, ['done', 'value']);

        const hitFiles = scanForString(dataDir, SECURITY_CANARY);
        assert.deepEqual(hitFiles, [], 'no stored session/report file may contain the resolved secret');
        assert.deepEqual(scanForString(dataDir, TOKEN), [], 'no stored session/report file may contain the bearer token');

        assert.deepEqual(resolvedIds, ['env:API_TOKEN']);
        assert.deepEqual(calls, [{name: 'browser.fill', args: {nodeId: 'secret-field', value: SECURITY_CANARY}}]);
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});