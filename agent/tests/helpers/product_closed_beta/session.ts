import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {promises as fs} from 'node:fs';
import {sendControlEval} from '../../../src/interface/control/client';
import {dispatch, runStep} from '../e2e_multitab_helper';
import type {StepUnion} from '../../../src/automation/runner/steps/types';
import type {Action} from '../../../src/interface/actions/action_protocol';
import type {ClosedBetaModelHandle} from './faux_model_server';

/**
 * Closed-beta product acceptance session — extension-transport layer.
 *
 * Spawns the REAL headless agent (production composition) which loads the REAL
 * extension bundle into a real Chromium, then drives the product exclusively
 * through the Workspace WS Action plane (`agent.product` — the exact transport
 * the extension SW speaks) plus `browser.*` runSteps against the real page.
 * No product HTTP base URL and no bearer token enter the extension path; the
 * extension storage carries only workspaceName/wsPort (see fresh_config).
 */

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const WORKSPACE_NAME = 'default';

export type ClosedBetaSessionOptions = {
    modelServer?: ClosedBetaModelHandle;
    workflowRoot?: string;
    interaction?: 'interactive' | 'headless';
    irreversibleApproval?: 'deny' | 'require-human' | 'allow';
    /** Enables the HTTP bearer-authenticated agent service. */
    auth?: {token: string};
    sessionStorageRoot?: string;
};

export type ClosedBetaSession = {
    endpoint: string;
    workspaceName: string;
    workflowRoot: string;
    sessionStorageRoot: string;
    model: {provider: string; model: string; baseUrl: string} | null;
    close: () => Promise<void>;
    product: (command: Record<string, unknown>) => Promise<unknown>;
    dispatch: (type: string, payload?: Record<string, unknown>) => Promise<Action>;
    runStep: (step: StepUnion) => Promise<{ok: boolean; data?: unknown; error?: {code?: string; message?: string}}>;
    evaluate: <T>(expression: string) => Promise<T>;
    /** Opens a new tab, activates it, and navigates to url. Returns the tab name. */
    openTab: (url: string) => Promise<string>;
};

const syncExtensionBuildStamp = async (cwd: string): Promise<void> => {
    const rootStamp = path.resolve(cwd, '..', '.dev', 'extension-build.json');
    const agentStampDir = path.resolve(cwd, '.dev');
    const stamp = await fs.readFile(rootStamp, 'utf8');
    const parsed = JSON.parse(stamp) as {mainExtensionPath?: unknown; startExtensionPath?: unknown};
    if (typeof parsed.mainExtensionPath !== 'string' || typeof parsed.startExtensionPath !== 'string') {
        throw new Error('extension build stamp is incomplete; run `pnpm build:extension` again');
    }
    await fs.mkdir(agentStampDir, {recursive: true});
    await fs.writeFile(path.join(agentStampDir, 'extension-build.json'), stamp, 'utf8');
};

export const startClosedBetaSession = async (
    options: ClosedBetaSessionOptions = {},
): Promise<ClosedBetaSession> => {
    const cwd = path.resolve(process.cwd());
    await syncExtensionBuildStamp(cwd);

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-closed-beta-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const endpoint = path.join(tempRoot, 'agent.sock');
    const workflowRoot = options.workflowRoot ?? path.join(tempRoot, 'workflow');
    const sessionStorageRoot = options.sessionStorageRoot ?? path.join(tempRoot, 'session-storage');
    const reportRoot = path.join(tempRoot, 'session-storage', 'reports');
    await fs.mkdir(userDataDir, {recursive: true});
    await fs.mkdir(workflowRoot, {recursive: true});
    await fs.mkdir(sessionStorageRoot, {recursive: true});

    const provider = options.modelServer?.provider ?? 'closed-beta';
    const model = options.modelServer?.model ?? 'closed-beta-model';

    const modelEnv = options.modelServer
        ? {
            RUNNER_AGENT_PROVIDER: provider,
            RUNNER_AGENT_MODEL: model,
            RUNNER_AGENT_BASE_URL: options.modelServer.baseUrl,
          }
        : {};

    const proc = spawn('pnpm', ['dev:headless'], {
        cwd,
        env: {
            ...process.env,
            RPA_CONTROL_EVAL: '1',
            RPA_CONTROL_ENDPOINT: endpoint,
            RPA_USER_DATA_DIR: userDataDir,
            RPA_WORKFLOW_ROOT: workflowRoot,
            RPA_AGENT_API_KEY: 'closed-beta-key',
            ...modelEnv,
            RUNNER_AGENT_INTERACTION: options.interaction ?? 'interactive',
            RUNNER_AGENT_SESSION_STORAGE_ROOT: sessionStorageRoot,
            RUNNER_AGENT_REPORT_ROOT: reportRoot,
            ...(options.irreversibleApproval
                ? {RUNNER_AGENT_GOVERNANCE_IRREVERSIBLE_APPROVAL: options.irreversibleApproval}
                : {}),
            ...(options.auth
                ? {RUNNER_AGENT_AUTH_ENABLED: 'true', RPA_AGENT_AUTH_TOKEN: options.auth.token}
                : {}),
        },
        stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 16_000) {
            stderr = stderr.slice(-16_000);
        }
    });

    const deadline = Date.now() + 45_000;
    let ready = false;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) {
            throw new Error(`closed-beta agent exited during startup (${String(proc.exitCode)})\n${stderr}`);
        }
        try {
            const probe = await sendControlEval(
                {source: 'return { ready: !!ctx?.workspaceRegistry && !!ctx?.dispatch && !!ctx?.runStep };', timeoutMs: 2000},
                {endpoint, timeoutMs: 2000},
            );
            if (probe.ok && (probe.result as {ready?: boolean})?.ready) {
                ready = true;
                break;
            }
        } catch {
            // agent still booting
        }
        await sleep(100);
    }
    if (!ready) {
        proc.kill('SIGKILL');
        throw new Error(`closed-beta agent startup timeout\n${stderr}`);
    }

    const endpointValue = endpoint;
    return {
        endpoint: endpointValue,
        workspaceName: WORKSPACE_NAME,
        workflowRoot,
        sessionStorageRoot,
        model: options.modelServer
            ? {provider, model, baseUrl: options.modelServer.baseUrl}
            : null,
        close: async () => {
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
            if (proc.exitCode === null) {
                proc.kill('SIGKILL');
            }
            await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => undefined);
        },
        product: async (command) => {
            const reply = await dispatch(endpointValue, productAction(command));
            if (reply.type !== 'agent.product.result') {
                throw new Error(`agent.product failed (${reply.type}): ${JSON.stringify(reply.payload ?? {})}`);
            }
            return reply.payload;
        },
        dispatch: async (type, payload = {}) => dispatch(endpointValue, workspaceAction(type, payload)),
        runStep: async (step) => {
            const result = await runStep(endpointValue, WORKSPACE_NAME, step);
            return result;
        },
        evaluate: async <T>(expression: string) => {
            const result = await runStep(endpointValue, WORKSPACE_NAME, {
                id: `evaluate-${Math.random().toString(36).slice(2)}`,
                name: 'browser.evaluate',
                args: {expression},
            } as StepUnion);
            if (!result.ok) {
                throw new Error(`browser.evaluate failed: ${JSON.stringify(result.error || {})}`);
            }
            return result.data as T;
        },
        openTab: async (url) => {
            const before = await dispatch(endpointValue, workspaceAction('tab.list', {}));
            const beforeNames = new Set(
                (((before.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs ?? []).map((tab) => tab.tabName),
            );
            const opened = await dispatch(endpointValue, workspaceAction('tab.open', {startUrl: url, source: 'e2e.closed-beta'}));
            if (opened.type !== 'tab.open.result') {
                throw new Error(`tab.open failed (${opened.type}): ${JSON.stringify(opened.payload ?? {})}`);
            }
            let tabName = '';
            const openedDeadline = Date.now() + 30_000;
            while (Date.now() < openedDeadline) {
                const listed = await dispatch(endpointValue, workspaceAction('tab.list', {}));
                const tabs = ((listed.payload ?? {}) as {tabs?: Array<{tabName: string}>}).tabs ?? [];
                const created = tabs.find((tab) => !beforeNames.has(tab.tabName));
                if (created?.tabName) {
                    tabName = created.tabName;
                    break;
                }
                await sleep(200);
            }
            if (!tabName) {
                throw new Error('opened closed-beta tab was not discovered');
            }
            const switched = await runStep(
                endpointValue,
                WORKSPACE_NAME,
                stepOf('switch-tab', 'browser.switch_tab', {tabName}),
            );
            if (!switched.ok) {
                throw new Error(`browser.switch_tab failed: ${JSON.stringify(switched.error || {})}`);
            }
            const navigated = await runStep(endpointValue, WORKSPACE_NAME, stepOf('goto', 'browser.goto', {url}));
            if (!navigated.ok) {
                throw new Error(`browser.goto failed: ${JSON.stringify(navigated.error || {})}`);
            }
            return tabName;
        },
    };
};

const workspaceAction = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type,
    workspaceName: WORKSPACE_NAME,
    payload,
    at: Date.now(),
});

const productAction = (command: Record<string, unknown>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: 'agent.product',
    workspaceName: WORKSPACE_NAME,
    payload: command,
    at: Date.now(),
});

const stepOf = <T extends StepUnion['name']>(
    id: string,
    name: T,
    args: Extract<StepUnion, {name: T}>['args'],
): Extract<StepUnion, {name: T}> => ({id, name, args} as unknown as Extract<StepUnion, {name: T}>);

/** Polls a predicate against the product surface until it settles. */
export const pollProduct = async <T>(
    fn: () => Promise<T | null | false>,
    timeoutMs: number,
    intervalMs = 250,
): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    let last: T | null | false = null;
    while (Date.now() < deadline) {
        last = await fn();
        if (last) {
            return last as T;
        }
        await sleep(intervalMs);
    }
    throw new Error(`product surface did not settle within ${String(timeoutMs)}ms (last=${JSON.stringify(last)})`);
};