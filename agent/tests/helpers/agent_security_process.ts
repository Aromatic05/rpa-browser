import {spawn} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {promises as fs} from 'node:fs';
import {sendControlEval} from '../../src/interface/control/client';
import {startSecurityFauxModel, type SecurityFauxModelHandle} from './agent_security_faux_model';
import type {Action} from '../../src/interface/actions/action_protocol';

export const SECURITY_WORKSPACE = 'default';

export const securityCanaryRefString = (envName = 'RPA_E2E_CANARY_SECRET'): string =>
    JSON.stringify({id: `env:${envName}`, kind: 'credential', provider: 'env'});

export const securityTokenRef = 'env:RPA_E2E_AUTH_TOKEN';

export const REVERSIBLE_SOURCE = [
    'use entity_rules "secret-rule" as page',
    'fill page.secretForm.secret with input.value',
    'output done = input.done',
].join('\n');

export const IRREVERSIBLE_SOURCE = [
    'use entity_rules "secret-rule" as page',
    'click page.secretForm.submit',
    'output done = input.done',
].join('\n');

const WORKFLOW_MANIFEST = [
    'version: 1',
    'name: default',
    'entry:',
    '  dsl: main',
    'createdAt: 1700000000000',
    'updatedAt: 1700000000600',
    'catalog:',
    '  - kind: entity_rules',
    '    name: secret-rule',
    '    title: secret-rule',
    '    createdAt: 1700000000100',
    '    updatedAt: 1700000000100',
    '    summary: rules=3, bindings=3',
    '    enabled: true',
].join('\n');

const MATCH_RULES = [
    'version: 2',
    'rules:',
    '  - ruleId: secret-root',
    '    source: region',
    '    expect: unique',
    '    match:',
    '      kind: form',
    '      idEquals: secret-form',
    '  - ruleId: secret-field',
    '    source: node',
    '    expect: unique',
    '    within: secret-root',
    '    match:',
    '      idEquals: secret-field',
    '  - ruleId: submit',
    '    source: node',
    '    expect: unique',
    '    within: secret-root',
    '    match:',
    '      idEquals: submit-button',
].join('\n');

const ANNOTATION = [
    'version: 2',
    'bindings:',
    '  - ruleId: secret-root',
    '    entityKey: secretForm',
    '    businessTag: secret.form',
    '    entityKind: form',
    '    displayName: Secret Form',
    '  - ruleId: secret-field',
    '    fieldKey: secret',
    '    fieldRole: field',
    '    fieldName: Secret',
    '    effect:',
    '      reversibility: reversible',
    '  - ruleId: submit',
    '    actionIntent: submit',
    '    actionRole: form',
    '    actionText: Submit',
    '    effect:',
    '      reversibility: irreversible',
].join('\n');

const PAGE_RULE = [
    'kind: form',
    'urlPattern: secret-form\\.html',
].join('\n');

export const SECRET_FORM_HTML = [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Secret Form</title></head>',
    '<body>',
    '  <form id="secret-form" aria-label="secret form">',
    '    <label for="secret-field">Secret<input id="secret-field" name="secret" autocomplete="off"></label>',
    '    <button id="submit-button" type="button">Submit</button>',
    '  </form>',
    '  <script>',
    '    const field = document.querySelector("#secret-field");',
    '    const button = document.querySelector("#submit-button");',
    '    field.addEventListener("input", () => { document.body.dataset.liveValue = field.value; });',
    '    button.addEventListener("click", () => {',
    '      document.body.dataset.submits = String(Number(document.body.dataset.submits || "0") + 1);',
    '      document.body.dataset.lastSubmitValue = field.value;',
    '    });',
    '  </script>',
    '</body>',
    '</html>',
].join('\n');

const assertExtensionBuildReady = async (cwd: string): Promise<void> => {
    const rootStamp = path.resolve(cwd, '..', '.dev', 'extension-build.json');
    const stamp = await fs.readFile(rootStamp, 'utf8');
    const parsed = JSON.parse(stamp) as {mainExtensionPath?: unknown};
    if (typeof parsed.mainExtensionPath !== 'string') {
        throw new Error('extension build stamp is incomplete; run `pnpm build:extension` again');
    }
    const mainStat = await fs.stat(parsed.mainExtensionPath).catch(() => null);
    if (!mainStat?.isDirectory()) {
        throw new Error(`extension build main path is missing: ${parsed.mainExtensionPath}`);
    }
};

export type SecurityAgentOptions = {
    interaction?: 'interactive' | 'headless';
    authToken?: string;
    canarySecret?: string;
    fauxProgramSource?: string;
    fauxProgramInput?: Record<string, unknown>;
    sessionStorageRoot: string;
    traceFilePath?: string;
};

export type SecurityAgentHandle = {
    endpoint: string;
    provider: string;
    model: string;
    faux: SecurityFauxModelHandle;
    tempRoot: string;
    close: () => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const startSecurityAgent = async (
    options: SecurityAgentOptions,
): Promise<SecurityAgentHandle> => {
    const cwd = path.resolve(process.cwd());
    await assertExtensionBuildReady(cwd);

    const faux = await startSecurityFauxModel({
        programSource: options.fauxProgramSource,
        programInput: options.fauxProgramInput,
    });
    const provider = 'security-faux';
    const model = 'security-e2e-model';

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-security-e2e-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const workflowRoot = path.join(tempRoot, 'workflow');
    const defaultWorkflow = path.join(workflowRoot, SECURITY_WORKSPACE);
    await fs.mkdir(path.join(defaultWorkflow, 'entity_rules', 'secret-rule'), {recursive: true});
    await fs.writeFile(path.join(defaultWorkflow, 'workflow.yaml'), WORKFLOW_MANIFEST, 'utf8');
    await fs.writeFile(path.join(defaultWorkflow, 'entity_rules', 'secret-rule', 'match.yaml'), MATCH_RULES, 'utf8');
    await fs.writeFile(path.join(defaultWorkflow, 'entity_rules', 'secret-rule', 'annotation.yaml'), ANNOTATION, 'utf8');
    await fs.writeFile(path.join(defaultWorkflow, 'entity_rules', 'secret-rule', 'page.yaml'), PAGE_RULE, 'utf8');

    const endpoint = path.join(tempRoot, 'agent.sock');
    await fs.mkdir(userDataDir, {recursive: true});

    const traceFilePath = options.traceFilePath ?? path.join(tempRoot, 'trace', 'trace.jsonl');
    const keepTemp = process.env.RPA_E2E_KEEP_TEMP === '1';

    const proc = spawn('pnpm', ['dev:headless'], {
        cwd,
        env: {
            ...process.env,
            RPA_CONTROL_EVAL: '1',
            RPA_CONTROL_ENDPOINT: endpoint,
            RPA_USER_DATA_DIR: userDataDir,
            RPA_WORKFLOW_ROOT: workflowRoot,
            RPA_AGENT_API_KEY: 'test-key',
            RUNNER_AGENT_PROVIDER: provider,
            RUNNER_AGENT_MODEL: model,
            RUNNER_AGENT_BASE_URL: faux.baseUrl,
            RUNNER_AGENT_INTERACTION: options.interaction ?? 'interactive',
            RUNNER_AGENT_SESSION_STORAGE_ROOT: options.sessionStorageRoot,
            RUNNER_AGENT_REPORT_ROOT: path.join(options.sessionStorageRoot, 'reports'),
            RUNNER_AGENT_AUTH_ENABLED: options.authToken === undefined ? 'false' : 'true',
            RUNNER_AGENT_AUTH_TOKEN_REF: securityTokenRef,
            RPA_E2E_AUTH_TOKEN: options.authToken ?? '',
            RPA_E2E_CANARY_SECRET: options.canarySecret ?? '',
            RUNNER_TRACE_FILE_ENABLED: 'true',
            RUNNER_TRACE_FILE_PATH: traceFilePath,
        },
        stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 12_000) {stderr = stderr.slice(-12_000);}
    });

    const waitAgentReady = async () => {
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline) {
            if (proc.exitCode !== null) {
                throw new Error(`agent exited during startup: ${String(proc.exitCode)}\n${stderr}`);
            }
            try {
                const probe = await sendControlEval(
                    {source: 'const w = ctx?.resolveWorkspace?.("default"); return { ready: !!ctx?.dispatch && !!ctx?.runStep && w?.browserSession?.status === "running" && w?.tabs?.listTabs?.().length > 0 };', timeoutMs: 2000},
                    {endpoint, timeoutMs: 2000},
                );
                if (probe.ok && (probe.result as {ready?: boolean})?.ready) {return;}
            } catch {
                // retry while the agent listens on the control socket
            }
            await sleep(100);
        }
        throw new Error(`agent startup timeout\n${stderr}`);
    };

    await waitAgentReady();

    return {
        endpoint,
        provider,
        model,
        faux,
        tempRoot,
        close: async () => {
            try {
                await faux.close();
            } catch {
                // best-effort
            }
            try {
                if (!proc.killed) {
                    proc.kill('SIGTERM');
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(resolve, 3000);
                        proc.once('exit', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                    });
                }
                if (proc.exitCode === null) {proc.kill('SIGKILL');}
            } finally {
                if (keepTemp) {
                    console.log(`[security-e2e] temp kept at ${tempRoot}`);
                } else {
                    await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => undefined);
                }
            }
        },
    };
};

export const startSecretFormPageServer = async (): Promise<{baseURL: string; close: () => Promise<void>}> => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, {'Content-Type': 'text/html'});
        res.end(SECRET_FORM_HTML);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    if (typeof address === 'string' || !address) {
        server.close();
        throw new Error('failed to allocate secret form page port');
    }
    return {
        baseURL: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((resolve) => {
            const timer = setTimeout(() => resolve(), 2000);
            server.close(() => {
                clearTimeout(timer);
                resolve();
            });
        }),
    };
};

export const securityAction = (type: string, payload: Record<string, unknown> = {}): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: SECURITY_WORKSPACE,
    payload,
    at: Date.now(),
});

export const dispatchControl = async (endpoint: string, action: Action): Promise<Action> => {
    const r = await sendControlEval(
        {source: 'return await ctx.dispatch(input.a);', input: {a: action}, timeoutMs: 20_000},
        {endpoint, timeoutMs: 20_000},
    );
    if (!r.ok) {throw new Error(`dispatch failed: ${String(r.error?.message ?? '')}`);}
    return r.result as Action;
};

export const runStepControl = async (
    endpoint: string,
    step: unknown,
): Promise<{ok: boolean; data?: unknown; error?: {code?: string; message?: string}}> => {
    const r = await sendControlEval(
        {source: 'return await ctx.runStep(input.s,input.w);', input: {s: step, w: SECURITY_WORKSPACE}, timeoutMs: 30_000},
        {endpoint, timeoutMs: 30_000},
    );
    if (!r.ok) {throw new Error(`runStep failed: ${String(r.error?.message ?? '')}`);}
    return r.result as {ok: boolean; data?: unknown; error?: {code?: string; message?: string}};
};

export const startAgentService = async (endpoint: string): Promise<number> => {
    const reply = await dispatchControl(endpoint, securityAction('agent.start'));
    if (reply.type !== 'agent.start.result') {
        throw new Error(`agent.start failed: ${reply.type}`);
    }
    const payload = reply.payload as {port: number; status: string};
    if (payload.status !== 'running') {
        throw new Error(`agent.start did not reach running: ${JSON.stringify(payload)}`);
    }
    return payload.port;
};

export const withBearerHeader = (token: string | undefined): Record<string, string> =>
    token === undefined ? {'content-type': 'application/json'} : {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
    };