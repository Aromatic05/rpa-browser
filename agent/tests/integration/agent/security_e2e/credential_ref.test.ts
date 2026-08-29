import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
    buildSecurityHarness,
    buildSecurityWorkspace,
    countingResolver,
    denyAllResolver,
    SECURITY_CANARY,
    apiTokenRefString,
    missingTokenRefString,
    REVERSIBLE_SOURCE,
    createProgramProposingModelRuntime,
    scanForString,
    mkdtempDir,
    withBearer,
} from '../../../helpers/agent_security_composition';

const MODEL_SOURCE = [
    'use entity_rules "secret-page" as page',
    'fill page.secretForm.secret with input.value',
    'output done = input.done',
].join('\n');

test('credential ref stays ref-only in model/session/report/trace while the mutation boundary receives the concrete value', async () => {
    const dataDir = mkdtempDir('agent-sec-cred-');
    const resolvedIds: string[] = [];
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const model = createProgramProposingModelRuntime({
        source: MODEL_SOURCE,
        input: {value: apiTokenRefString(), done: true},
    });
    const harness = await buildSecurityHarness({
        portBegin: 30600,
        credentialResolver: countingResolver(resolvedIds),
        dataDir,
        browserWorld: world,
        modelRuntime: model.runtime,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    let sessionId = '';
    try {
        const run = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: withBearer(undefined),
            body: JSON.stringify({
                prompt: 'fill the secret form field',
                provider: model.provider,
                model: model.model,
            }),
        });
        assert.equal(run.status, 200);
        sessionId = run.headers.get('x-session-id')!;
        const runText = await run.text();
        assert.ok(!runText.includes(SECURITY_CANARY), 'raw secret must never reach the run result');
        const result = JSON.parse(runText) as {
            text: string;
            trace: {tools: Array<{toolName: string; args: Record<string, unknown>}>};
            programs: Array<{status: string; input: Record<string, unknown>}>;
        };
        assert.equal(result.text, 'Completed through the program transaction.');
        assert.equal(result.programs[0].status, 'completed');
        assert.deepEqual(result.programs[0].input, {value: apiTokenRefString(), done: true});

        const modelTool = result.trace.tools.find((tool) => tool.toolName === 'agent.execute_program');
        assert.ok(modelTool, 'the react trace must record the model-proposed program');
        assert.deepEqual(modelTool!.args.input, {value: apiTokenRefString(), done: true});
        assert.ok(!JSON.stringify(modelTool!.args).includes(SECURITY_CANARY), 'trace tool args must stay ref-only');

        const report = await fetch(`${baseUrl}/agent/sessions/${sessionId}/report`);
        const reportText = await report.text();
        assert.ok(!reportText.includes(SECURITY_CANARY), 'report must not contain the resolved secret');
        const reportJson = JSON.parse(reportText) as {report: {toolCalls: Array<{args: Record<string, unknown>}>}};
        assert.deepEqual(reportJson.report.toolCalls[0].args.input, {value: apiTokenRefString(), done: true});

        assert.deepEqual(resolvedIds, ['env:API_TOKEN']);
        assert.deepEqual(calls, [{name: 'browser.fill', args: {nodeId: 'secret-field', value: SECURITY_CANARY}}]);
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), [], 'stored session/report files must never hold the secret');
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('an unresolvable credential ref blocks the mutation and never replays earlier effects', async () => {
    const dataDir = mkdtempDir('agent-sec-cred-block-');
    const resolvedIds: string[] = [];
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30600,
        credentialResolver: countingResolver(resolvedIds),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    const source = [
        'use entity_rules "secret-page" as page',
        'fill page.secretForm.secret with input.first',
        'fill page.secretForm.secret with input.second',
    ].join('\n');
    let sessionId = '';
    try {
        const run = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                prompt: 'fill then fill with a missing credential',
                provider: harness.provider,
                model: harness.model,
                source,
                input: {first: 'alice', second: missingTokenRefString()},
            }),
        });
        assert.equal(run.status, 200);
        sessionId = run.headers.get('x-session-id')!;
        const runText = await run.text();
        assert.ok(!runText.includes(SECURITY_CANARY), 'an unresolved secret must never surface');
        assert.ok(runText.includes('ERR_SECURITY_CREDENTIAL_NOT_FOUND'), 'the failure must name the missing-credential code');

        const status = await fetch(`${baseUrl}/agent/sessions/${sessionId}`);
        const snapshot = await status.json() as {
            state: string;
            resumable: boolean;
            interactions: unknown[];
            result: {programs: Array<{pause: {failure: {code: string}} | undefined}>} | null;
        };
        assert.equal(snapshot.state, 'paused');
        assert.equal(snapshot.resumable, false, 'a failure pause must not be resumable');
        assert.deepEqual(snapshot.interactions, [], 'a failure pause must not create an approval interaction');
        assert.equal(snapshot.result?.programs?.[0].pause?.failure.code, 'ERR_SECURITY_CREDENTIAL_NOT_FOUND');

        assert.deepEqual(calls, [{
            name: 'browser.fill',
            args: {nodeId: 'secret-field', value: 'alice'},
        }], 'only the resolvable first effect may reach the browser; the blocked one must not be replayed');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('deny-all resolver blocks a credential ref before any browser mutation', async () => {
    const dataDir = mkdtempDir('agent-sec-cred-deny-');
    const calls: Array<{name: string; args: Record<string, unknown>}> = [];
    const world = await buildSecurityWorkspace({calls});
    const harness = await buildSecurityHarness({
        portBegin: 30600,
        credentialResolver: denyAllResolver(),
        dataDir,
        browserWorld: world,
    });
    const port = await harness.start();
    const baseUrl = `http://127.0.0.1:${String(port)}`;
    try {
        const run = await fetch(`${baseUrl}/agent`, {
            method: 'POST',
            headers: {'content-type': 'application/json'},
            body: JSON.stringify({
                prompt: 'fill with a denied credential',
                provider: harness.provider,
                model: harness.model,
                source: REVERSIBLE_SOURCE,
                input: {value: apiTokenRefString(), done: true},
            }),
        });
        assert.equal(run.status, 200);
        const runText = await run.text();
        assert.ok(!runText.includes(SECURITY_CANARY));
        assert.ok(runText.includes('ERR_SECURITY_CREDENTIAL_UNRESOLVABLE'));
        assert.deepEqual(calls, [], 'the browser step must never run for a denied credential');
        assert.deepEqual(scanForString(dataDir, SECURITY_CANARY), []);
    } finally {
        await harness.stop();
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});