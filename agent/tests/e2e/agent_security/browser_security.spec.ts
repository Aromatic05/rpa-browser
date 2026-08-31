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
