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

export type StepResultItem = {
    runId: string;
    cursor: number;
    stepId: string;
    ok: boolean;
    data?: unknown;
    error?: { code?: string; message?: string };
    ts: number;
};

export type E2EStepActionHarness = {
    workspaceName: string;
    tabName: string;
    fixtureUrl: string;
    runStep: (step: StepUnion) => Promise<StepResultItem>;
    dispatchAction: (action: Action) => Promise<Action>;
    close: () => Promise<void>;
};

const delay = async (ms: number) => await new Promise<void>((resolve) => setTimeout(resolve, ms));

const makeAction = (input: Pick<Action, 'type' | 'workspaceName' | 'payload'>): Action => ({
    v: 1,
    id: crypto.randomUUID(),
    type: input.type,
    workspaceName: input.workspaceName,
    payload: input.payload,
    at: Date.now(),
});

const parseEvalResult = <T>(result: unknown): T => result as T;

export const createE2EStepActionHarness = async (): Promise<E2EStepActionHarness> => {
    const rootDir = path.resolve(process.cwd());
    const agentDir = rootDir;
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-step-actions-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const runnerDistLink = path.join(tempRoot, '.runner-dist');
    await fs.mkdir(userDataDir, { recursive: true });
    await fs.symlink(path.resolve(agentDir, '.runner-dist'), runnerDistLink, 'dir');

    const controlEndpoint = getDefaultControlEndpoint();
    const fixture = await startFixtureServer();
    let workspaceName = `e2e-step-ws-${crypto.randomUUID()}`;
    let agentProcess: ChildProcessWithoutNullStreams | null = null;

    const headed = process.env.RPA_E2E_HEADED === '1';
    const headedStepDelayMs = headed ? 350 : 0;
    const agentEntry = path.resolve(agentDir, 'src/index.ts');
    const tsxBin = path.resolve(agentDir, 'node_modules/.bin/tsx');
    let agentStdout = '';
    let agentStderr = '';

    agentProcess = spawn(tsxBin, [agentEntry], {
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
        if (agentStdout.length > 8000) {
            agentStdout = agentStdout.slice(-8000);
        }
    });
    agentProcess.stderr.on('data', (chunk) => {
        agentStderr += chunk.toString();
        if (agentStderr.length > 8000) {
            agentStderr = agentStderr.slice(-8000);
        }
    });

    const waitControlReady = async () => {
        for (let i = 0; i < 120; i += 1) {
            try {
                const response = await sendControlEval({ source: 'return { ready: true }', timeoutMs: 1000 }, { endpoint: controlEndpoint, timeoutMs: 1000 });
                if (response.ok) {
                    return;
                }
            } catch {}
            if (agentProcess?.exitCode !== null) {
                throw new Error(`agent exited early: code=${agentProcess.exitCode}, stderr=${agentStderr}, stdout=${agentStdout}`);
            }
            await delay(250);
        }
        throw new Error(`control endpoint not ready in time; stderr=${agentStderr}; stdout=${agentStdout}`);
    };

    const dispatchAction = async (action: Action): Promise<Action> => {
        const source = `
const action = input.action;
return await ctx.dispatch(action);
`;
        const response = await sendControlEval(
            { source, input: { action }, timeoutMs: 15000 },
            { endpoint: controlEndpoint, timeoutMs: 15000 },
        );
        if (!response.ok) {
            throw new Error(`dispatch action failed: ${response.error?.message || 'unknown error'}`);
        }
        return parseEvalResult<Action>(response.result);
    };

    const runStep = async (step: StepUnion): Promise<StepResultItem> => {
        const response = await sendControlEval(
            {
                source: 'return await ctx.runStep(input.step, input.workspaceName);',
                input: { step, workspaceName },
                timeoutMs: 20000,
            },
            { endpoint: controlEndpoint, timeoutMs: 20000 },
        );
        if (!response.ok) {
            throw new Error(`runStep failed: ${response.error?.message || 'unknown error'}`);
        }
        if (headedStepDelayMs > 0) {
            await delay(headedStepDelayMs);
        }
        const result = response.result as { stepId: string; ok: boolean; data?: unknown; error?: { code?: string; message?: string } };
        return {
            runId: crypto.randomUUID(),
            cursor: 0,
            stepId: result.stepId,
            ok: result.ok,
            data: result.data,
            error: result.error,
            ts: Date.now(),
        };
    };

    await waitControlReady();

    const created = await dispatchAction(makeAction({ type: 'workspace.create' }));
    const createdWorkspaceName = (created.payload as { workspaceName?: string } | undefined)?.workspaceName;
    if (!createdWorkspaceName) {
        throw new Error(`workspace create missing workspaceName, reply=${JSON.stringify(created)}`);
    }
    workspaceName = createdWorkspaceName;

    const tabReply = await dispatchAction(makeAction({
        type: 'tab.create',
        workspaceName,
        payload: { startUrl: `${fixture.baseURL}/step_actions/customer_profile.html` },
    }));
    const tabName = (tabReply.payload as { tabName: string }).tabName;

    return {
        workspaceName,
        tabName,
        fixtureUrl: `${fixture.baseURL}/step_actions/customer_profile.html`,
        runStep,
        dispatchAction,
        close: async () => {
            try {
                await fixture.close();
            } finally {
                if (agentProcess && !agentProcess.killed) {
                    agentProcess.kill('SIGTERM');
                }
                await fs.rm(tempRoot, { recursive: true, force: true });
            }
        },
    };
};
