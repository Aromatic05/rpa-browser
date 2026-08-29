import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
    startSecurityAgent,
    startSecretFormPageServer,
    startAgentService,
    runStepControl,
    dispatchControl,
    securityAction,
    withBearerHeader,
    securityCanaryRefString,
    REVERSIBLE_SOURCE,
    IRREVERSIBLE_SOURCE,
    type SecurityAgentHandle,
} from '../../helpers/agent_security_process';

const CANARY = 'tok_real_browser_canary_5f8b1e';
const TOKEN = 'real-browser-bearer-token';

test.describe.configure({timeout: 300_000});

const step = (id: string, name: string, args: Record<string, unknown>): unknown => ({id, name, args});

const evaluate = async (endpoint: string, expression: string): Promise<string> => {
    const result = await runStepControl(endpoint, step(`evaluate-${Date.now()}`, 'browser.evaluate', {expression}));
    if (!result.ok) {throw new Error(`browser.evaluate failed: ${JSON.stringify(result.error ?? {})}`);}
    return result.data as string;
};

const scanDir = (root: string, needle: string): string[] => {
    const hits: string[] = [];
    const visit = (dir: string): void => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, {withFileTypes: true});
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {visit(full); continue;}
            if (!entry.isFile()) {continue;}
            try {
                if (fs.readFileSync(full, 'utf8').includes(needle)) {hits.push(full);}
            } catch {
                // unreadable files are skipped
            }
        }
    };
    visit(root);
    return hits;
};

let agent: SecurityAgentHandle;
let baseUrl: string;
let httpPort: number;
let sessionRoot: string;
let traceFilePath: string;
let runTempRoot: string;
const observedHttpBodies: string[] = [];

test.beforeAll(async () => {
    runTempRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rpa-security-e2e-run-'));
    sessionRoot = path.join(runTempRoot, 'sessions');
    traceFilePath = path.join(runTempRoot, 'trace', 'trace.jsonl');

    const pageServer = await startSecretFormPageServer();
    const agentHandle = await startSecurityAgent({
        interaction: 'interactive',
        authToken: TOKEN,
        canarySecret: CANARY,
        sessionStorageRoot: sessionRoot,
        traceFilePath,
    });
    agent = agentHandle;
    baseUrl = pageServer.baseURL;

    let tabName = '';
    await expect.poll(async () => {
        const reply = await dispatchControl(agent.endpoint, securityAction('tab.list'));
        const tabs = (reply.payload as {tabs?: Array<{tabName: string; active?: boolean}>}).tabs ?? [];
        tabName = tabs.find((tab) => tab.active)?.tabName ?? tabs[0]?.tabName ?? '';
        return tabName;
    }, {timeout: 30_000}).not.toBe('');

    const switched = await runStepControl(agent.endpoint, step('switch', 'browser.switch_tab', {tabName}));
    expect(switched.ok, JSON.stringify(switched.error ?? {})).toBe(true);

    const navigated = await runStepControl(agent.endpoint, step('goto', 'browser.goto', {url: `${baseUrl}/secret-form.html`}));
    expect(navigated.ok, JSON.stringify(navigated.error ?? {})).toBe(true);

    httpPort = await startAgentService(agent.endpoint);
});

test.afterAll(async () => {
    if (agent) {
        await agent.close();
    }
    if (runTempRoot) {
        await fs.promises.rm(runTempRoot, {recursive: true, force: true}).catch(() => undefined);
    }
});

const agentHttp = (pathname: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`http://127.0.0.1:${String(httpPort)}${pathname}`, init);

test('real browser: auth rejects missing/wrong bearer and the credential mutation fills the DOM without leaking the canary anywhere else', async () => {
    const body = {
        prompt: 'fill the secret field with the credential reference',
        provider: agent.provider,
        model: agent.model,
        source: REVERSIBLE_SOURCE,
        input: {value: securityCanaryRefString(), done: true},
    };

    const missing = await agentHttp('/agent', {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(body),
    });
    expect(missing.status).toBe(401);
    const missingText = await missing.text();
    observedHttpBodies.push(missingText);
    expect(missingText.includes(TOKEN)).toBe(false);
    expect(missingText.includes(CANARY)).toBe(false);

    const wrong = await agentHttp('/agent', {
        method: 'POST',
        headers: {'content-type': 'application/json', authorization: 'Bearer wrong-token'},
        body: JSON.stringify(body),
    });
    expect(wrong.status).toBe(401);
    const wrongText = await wrong.text();
    observedHttpBodies.push(wrongText);
    expect(wrongText.includes(TOKEN)).toBe(false);
    expect(wrongText.includes(CANARY)).toBe(false);

    const accepted = await agentHttp('/agent', {
        method: 'POST',
        headers: withBearerHeader(TOKEN),
        body: JSON.stringify(body),
    });
    expect(accepted.status).toBe(200);
    const acceptedText = await accepted.text();
    observedHttpBodies.push(acceptedText);
    expect(acceptedText.includes(TOKEN), 'a successful auth must not echo the bearer token').toBe(false);
    expect(acceptedText.includes(CANARY), 'the run result must not contain the resolved secret').toBe(false);
    const result = JSON.parse(acceptedText) as {programs: Array<{status: string; input: Record<string, unknown>}>};
    expect(result.programs[0].status).toBe('completed');
    expect(result.programs[0].input.value).toBe(securityCanaryRefString());
    const sessionId = accepted.headers.get('x-session-id')!;
    expect(sessionId).toBeTruthy();

    const statusBody = await (await agentHttp(`/agent/sessions/${sessionId}`, {headers: withBearerHeader(TOKEN)})).text();
    observedHttpBodies.push(statusBody);
    expect(statusBody.includes(CANARY)).toBe(false);

    const reportBody = await (await agentHttp(`/agent/sessions/${sessionId}/report`, {headers: withBearerHeader(TOKEN)})).text();
    observedHttpBodies.push(reportBody);
    expect(reportBody.includes(CANARY)).toBe(false);

    const domValue = await evaluate(agent.endpoint, "document.querySelector('#secret-field').value");
    expect(domValue).toBe(CANARY);
    const liveValue = await evaluate(agent.endpoint, "document.body.dataset.liveValue || ''");
    expect(liveValue).toBe(CANARY);

    expect(scanDir(sessionRoot, CANARY)).toEqual([]);
    expect(scanDir(path.join(sessionRoot, "reports"), CANARY)).toEqual([]);
    const traceText = fs.existsSync(traceFilePath) ? fs.readFileSync(traceFilePath, 'utf8') : '';
    expect(traceText.includes(CANARY), 'the runner trace file must never hold the resolved secret').toBe(false);
    for (const text of observedHttpBodies) {
        expect(text.includes(CANARY), 'every serialized HTTP response must be free of the resolved secret').toBe(false);
    }
});

test('real browser: an irreversible barrier pauses, approve executes the retained effect once in the DOM', async () => {
    const body = {
        prompt: 'approve the irreversible submit',
        provider: agent.provider,
        model: agent.model,
        source: IRREVERSIBLE_SOURCE,
        input: {done: true},
    };
    const run = await agentHttp('/agent', {
        method: 'POST',
        headers: withBearerHeader(TOKEN),
        body: JSON.stringify(body),
    });
    expect(run.status).toBe(200);
    const runText = await run.text();
    observedHttpBodies.push(runText);
    expect(runText.includes(CANARY)).toBe(false);
    const sessionId = run.headers.get('x-session-id')!;

    const listed = await (await agentHttp(`/agent/sessions/${sessionId}/interactions`, {headers: withBearerHeader(TOKEN)})).json() as {
        interactions: Array<{id: string; kind: string; status: string; revision: number; evidence: {effectName?: string}}>;
    };
    expect(listed.interactions).toHaveLength(1);
    expect(listed.interactions[0].kind).toBe('irreversible-effect-approval');
    expect(listed.interactions[0].status).toBe('pending');
    expect(listed.interactions[0].evidence.effectName).toBe('browser.click');
    const interaction = listed.interactions[0];

    expect(await evaluate(agent.endpoint, "document.body.dataset.submits || '0'")).toBe('0');

    const approved = await agentHttp(
        `/agent/sessions/${sessionId}/interactions/${interaction.id}/approve`,
        {
            method: 'POST',
            headers: withBearerHeader(TOKEN),
            body: JSON.stringify({revision: interaction.revision, approvedBy: 'ops-1'}),
        },
    );
    expect(approved.status).toBe(200);
    const approvedText = await approved.text();
    observedHttpBodies.push(approvedText);
    expect(approvedText.includes(CANARY)).toBe(false);
    const decision = JSON.parse(approvedText) as {interaction: {status: string}};
    expect(decision.interaction.status).toBe('approved');

    await expect.poll(async () => {
        const snapshot = await (await agentHttp(`/agent/sessions/${sessionId}`, {headers: withBearerHeader(TOKEN)})).json() as {state: string};
        return snapshot.state;
    }, {timeout: 15_000}).toBe('completed');
    await expect.poll(async () => await evaluate(agent.endpoint, "document.body.dataset.submits || '0'"), {timeout: 15_000}).toBe('1');
    expect(scanDir(sessionRoot, CANARY)).toEqual([]);
    expect(scanDir(path.join(sessionRoot, "reports"), CANARY)).toEqual([]);
    for (const modelBody of agent.faux.requestBodies()) {
        expect(modelBody.includes(CANARY), 'the model request body must never contain the resolved secret').toBe(false);
    }
});

test('real browser: deny cancels the retained session and never executes the irreversible effect', async () => {
    const body = {
        prompt: 'approve the irreversible submit',
        provider: agent.provider,
        model: agent.model,
        source: IRREVERSIBLE_SOURCE,
        input: {done: true},
    };
    const run = await agentHttp('/agent', {
        method: 'POST',
        headers: withBearerHeader(TOKEN),
        body: JSON.stringify(body),
    });
    const sessionId = run.headers.get('x-session-id')!;
    await run.text();
    const listed = await (await agentHttp(`/agent/sessions/${sessionId}/interactions`, {headers: withBearerHeader(TOKEN)})).json() as {
        interactions: Array<{id: string; revision: number}>;
    };
    const interaction = listed.interactions[0];

    const denied = await agentHttp(
        `/agent/sessions/${sessionId}/interactions/${interaction.id}/deny`,
        {
            method: 'POST',
            headers: withBearerHeader(TOKEN),
            body: JSON.stringify({revision: interaction.revision, deniedBy: 'ops-2', reason: 'not safe'}),
        },
    );
    expect(denied.status).toBe(200);
    const deniedText = await denied.text();
    observedHttpBodies.push(deniedText);
    expect(deniedText.includes(CANARY)).toBe(false);
    const deniedJson = JSON.parse(deniedText) as {interaction: {status: string}};
    expect(deniedJson.interaction.status).toBe('denied');

    await expect.poll(async () => {
        const snapshot = await (await agentHttp(`/agent/sessions/${sessionId}`, {headers: withBearerHeader(TOKEN)})).json() as {state: string; error: {code: string}};
        return `${snapshot.state}:${snapshot.error.code}`;
    }, {timeout: 15_000}).toBe('cancelled:ERR_SESSION_INTERACTION_DENIED');

    await expect.poll(async () => await evaluate(agent.endpoint, "document.body.dataset.submits || '0'"), {timeout: 10_000}).toBe('1');
});