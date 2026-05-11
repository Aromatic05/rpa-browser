import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sendControlEval } from '../../src/control/client';
import { getDefaultControlEndpoint } from '../../src/control/transport';
import { startFixtureServer } from './server';
import type { Action } from '../../src/actions/action_protocol';
import type { StepUnion } from '../../src/runner/steps/types';

type TabSummary = { tabName: string; url: string; title: string; active: boolean };

type ActionReplyPayload = Record<string, unknown>;

const delay = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

const makeAction = (input: Pick<Action, 'type' | 'workspaceName' | 'payload'>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: input.type,
    workspaceName: input.workspaceName,
    payload: input.payload,
    at: Date.now(),
});

const mustReplyOk = (reply: Action, message: string): void => {
    if (reply.type.endsWith('.failed')) {
        throw new Error(`${message}: ${JSON.stringify(reply)}`);
    }
};

export type MultitabHarness = {
    baseURL: string;
    createWorkspaceAndOpen: (url: string) => Promise<{ workspaceName: string; tabName: string }>;
    dispatchAction: (action: Action) => Promise<Action>;
    runStep: (workspaceName: string, step: StepUnion) => Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }>;
    clickActiveTab: (workspaceName: string, selector: string) => Promise<void>;
    waitForTabCount: (workspaceName: string, expectedCount: number) => Promise<TabSummary[]>;
    waitForTabCountIncrease: (workspaceName: string, previousCount: number) => Promise<TabSummary[]>;
    waitForTabByUrlPart: (workspaceName: string, urlPart: string) => Promise<TabSummary>;
    waitForWorkspaceState: (workspaceName: string, expected: 'idle' | 'recording' | 'playing') => Promise<void>;
    readWorkbenchState: (workspaceName: string) => Promise<Record<string, string>>;
    close: () => Promise<void>;
};

export const createMultitabHarness = async (): Promise<MultitabHarness> => {
    const rootDir = path.resolve(process.cwd());
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-multitab-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const runnerDistLink = path.join(tempRoot, '.runner-dist');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.symlink(path.resolve(rootDir, '.runner-dist'), runnerDistLink, 'dir');

    const fixture = await startFixtureServer();
    const controlEndpoint = getDefaultControlEndpoint();
    const headed = process.env.RPA_E2E_HEADED === '1';
    const headedStepDelayMs = headed ? 350 : 0;
    const tsxBin = path.resolve(rootDir, 'node_modules/.bin/tsx');
    const agentEntry = path.resolve(rootDir, 'src/index.ts');

    let agentStdout = '';
    let agentStderr = '';
    const agentProcess: ChildProcessWithoutNullStreams = spawn(tsxBin, [agentEntry], {
        cwd: tempRoot,
        env: {
            ...process.env,
            RPA_CONTROL_EVAL: '1',
            RPA_HEADLESS: headed ? 'false' : 'true',
            RPA_USER_DATA_DIR: userDataDir,
        },
        stdio: 'pipe',
    });
    agentProcess.stdout.on('data', (chunk) => {
        agentStdout += chunk.toString();
        if (agentStdout.length > 12000) {agentStdout = agentStdout.slice(-12000);}
    });
    agentProcess.stderr.on('data', (chunk) => {
        agentStderr += chunk.toString();
        if (agentStderr.length > 12000) {agentStderr = agentStderr.slice(-12000);}
    });

    const waitControlReady = async () => {
        for (let i = 0; i < 120; i += 1) {
            try {
                const res = await sendControlEval({ source: 'return { ready: true };', timeoutMs: 1000 }, { endpoint: controlEndpoint, timeoutMs: 1000 });
                if (res.ok) {return;}
            } catch {}
            if (agentProcess.exitCode !== null) {
                throw new Error(`agent exited: code=${agentProcess.exitCode}, stderr=${agentStderr}, stdout=${agentStdout}`);
            }
            await delay(250);
        }
        throw new Error(`control endpoint not ready; stderr=${agentStderr}; stdout=${agentStdout}`);
    };

    const dispatchAction = async (action: Action): Promise<Action> => {
        const res = await sendControlEval(
            {
                source: 'return await ctx.dispatch(input.action);',
                input: { action },
                timeoutMs: 20000,
            },
            { endpoint: controlEndpoint, timeoutMs: 20000 },
        );
        if (!res.ok) {
            throw new Error(`dispatch action failed: ${res.error?.message || 'unknown'}`);
        }
        if (headedStepDelayMs > 0) {
            await delay(headedStepDelayMs);
        }
        return res.result as Action;
    };

    const runStep = async (workspaceName: string, step: StepUnion): Promise<{ ok: boolean; data?: unknown; error?: { code?: string; message?: string } }> => {
        const res = await sendControlEval(
            {
                source: 'return await ctx.runStep(input.step, input.workspaceName);',
                input: { workspaceName, step },
                timeoutMs: 25000,
            },
            { endpoint: controlEndpoint, timeoutMs: 25000 },
        );
        if (!res.ok) {
            throw new Error(`runStep failed: ${res.error?.message || 'unknown'}`);
        }
        if (headedStepDelayMs > 0) {
            await delay(headedStepDelayMs);
        }
        const result = res.result as { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
        return result;
    };

    const clickActiveTab = async (workspaceName: string, selector: string): Promise<void> => {
        const res = await sendControlEval(
            {
                source: `\nconst ws = ctx.workspaceRegistry.getWorkspace(input.workspaceName);\nif (!ws) throw new Error('workspace not found');\nconst active = ws.tabs.getActiveTab();\nif (!active || !active.page) throw new Error('active tab page not found');\nawait active.page.click(input.selector);\nreturn { clicked: true };\n`,
                input: { workspaceName, selector },
                timeoutMs: 20000,
            },
            { endpoint: controlEndpoint, timeoutMs: 20000 },
        );
        if (!res.ok) {
            throw new Error(`clickActiveTab failed: ${res.error?.message || 'unknown'}`);
        }
        if (headedStepDelayMs > 0) {
            await delay(headedStepDelayMs);
        }
    };

    const listTabs = async (workspaceName: string): Promise<TabSummary[]> => {
        const reply = await dispatchAction(makeAction({ type: 'tab.list', workspaceName }));
        mustReplyOk(reply, 'tab.list failed');
        const payload = (reply.payload || {}) as { tabs?: TabSummary[] };
        return Array.isArray(payload.tabs) ? payload.tabs : [];
    };

    const waitForTabCount = async (workspaceName: string, expectedCount: number): Promise<TabSummary[]> => {
        for (let i = 0; i < 100; i += 1) {
            const tabs = await listTabs(workspaceName);
            if (tabs.length === expectedCount) {
                return tabs;
            }
            await delay(100);
        }
        throw new Error(`tab count not reached: expected=${expectedCount}`);
    };

    const waitForTabCountIncrease = async (workspaceName: string, previousCount: number): Promise<TabSummary[]> => {
        let lastTabs: TabSummary[] = [];
        for (let i = 0; i < 120; i += 1) {
            const tabs = await listTabs(workspaceName);
            lastTabs = tabs;
            if (tabs.length > previousCount) {
                return tabs;
            }
            await delay(100);
        }
        throw new Error(`tab count did not increase: previous=${previousCount}, lastTabs=${JSON.stringify(lastTabs)}`);
    };

    const waitForTabByUrlPart = async (workspaceName: string, urlPart: string): Promise<TabSummary> => {
        for (let i = 0; i < 100; i += 1) {
            const tabs = await listTabs(workspaceName);
            const found = tabs.find((tab) => typeof tab.url === 'string' && tab.url.includes(urlPart));
            if (found) {return found;}
            await delay(100);
        }
        throw new Error(`tab url not found: ${urlPart}`);
    };

    const waitForWorkspaceState = async (workspaceName: string, expected: 'idle' | 'recording' | 'playing'): Promise<void> => {
        for (let i = 0; i < 120; i += 1) {
            const res = await sendControlEval(
                {
                    source: 'const ws = ctx.workspaceRegistry.getWorkspace(input.workspaceName); return ws ? ws.state : null;',
                    input: { workspaceName },
                    timeoutMs: 3000,
                },
                { endpoint: controlEndpoint, timeoutMs: 3000 },
            );
            if (res.ok && res.result === expected) {
                return;
            }
            await delay(100);
        }
        throw new Error(`workspace state not reached: ${workspaceName} -> ${expected}`);
    };

    const createWorkspaceAndOpen = async (url: string): Promise<{ workspaceName: string; tabName: string }> => {
        const wsReply = await dispatchAction(makeAction({ type: 'workspace.create' }));
        mustReplyOk(wsReply, 'workspace.create failed');
        const workspaceName = ((wsReply.payload || {}) as { workspaceName?: string }).workspaceName;
        if (!workspaceName) {
            throw new Error(`workspace.create missing workspaceName: ${JSON.stringify(wsReply)}`);
        }
        const tabReply = await dispatchAction(makeAction({ type: 'tab.create', workspaceName, payload: { startUrl: url } }));
        mustReplyOk(tabReply, 'tab.create failed');
        const tabName = ((tabReply.payload || {}) as { tabName?: string }).tabName;
        if (!tabName) {
            throw new Error(`tab.create missing tabName: ${JSON.stringify(tabReply)}`);
        }
        return { workspaceName, tabName };
    };

    const readWorkbenchState = async (workspaceName: string): Promise<Record<string, string>> => {
        const res = await runStep(workspaceName, {
            id: `wb-read-${crypto.randomUUID()}`,
            name: 'browser.evaluate',
            args: {
                expression: `
const box = document.querySelector('[data-testid="multi-status"]');
return {
  ticketStatus: box?.dataset.ticketStatus || '',
  usedRule: box?.dataset.usedRule || '',
  paymentStatus: box?.dataset.paymentStatus || '',
  customerSynced: box?.dataset.customerSynced || '',
  auditOpened: box?.dataset.auditOpened || '',
  customerTag: box?.dataset.customerTag || ''
};`,
            },
        } as StepUnion);
        if (!res.ok) {
            throw new Error(`read workbench state failed: ${JSON.stringify(res.error)}`);
        }
        return (res.data || {}) as Record<string, string>;
    };

    await waitControlReady();

    return {
        baseURL: fixture.baseURL,
        createWorkspaceAndOpen,
        dispatchAction,
        runStep,
        clickActiveTab,
        waitForTabCount,
        waitForTabCountIncrease,
        waitForTabByUrlPart,
        waitForWorkspaceState,
        readWorkbenchState,
        close: async () => {
            try {
                if (!agentProcess.killed) {
                    agentProcess.kill('SIGTERM');
                    await new Promise<void>((resolve) => {
                        const timer = setTimeout(() => resolve(), 2000);
                        agentProcess.once('exit', () => {
                            clearTimeout(timer);
                            resolve();
                        });
                    });
                }
                if (agentProcess.exitCode === null) {
                    agentProcess.kill('SIGKILL');
                }
                await fixture.close();
            } finally {
                await fs.rm(tempRoot, { recursive: true, force: true });
            }
        },
    };
};
