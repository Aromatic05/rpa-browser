import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { sendControlEval } from '../../src/interface/control/client';
import { startFauxModel, type FauxModelHandle, type FauxModelOptions } from './agent_e2e_faux_model';

export type AgentE2EHandle = {
    endpoint: string;
    model: {provider: string; model: string};
    faux: FauxModelHandle;
    close: () => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const assertExtensionBuildReady = async (cwd: string): Promise<void> => {
    const rootStamp = path.resolve(cwd, '..', '.dev', 'extension-build.json');
    let stamp: string;
    try {
        stamp = await fs.readFile(rootStamp, 'utf8');
    } catch {
        throw new Error([
            'extension build stamp missing',
            `expected: ${rootStamp}`,
            'run `pnpm build:extension` before the agent e2e slice',
        ].join('\n'));
    }
    const parsed = JSON.parse(stamp) as {mainExtensionPath?: unknown};
    if (typeof parsed.mainExtensionPath !== 'string') {
        throw new Error('extension build stamp is incomplete; run `pnpm build:extension` again');
    }
    const mainStat = await fs.stat(parsed.mainExtensionPath).catch(() => null);
    if (!mainStat?.isDirectory()) {
        throw new Error(`extension build main path is missing: ${parsed.mainExtensionPath}`);
    }
};

export const startAgentWithFauxModel = async (
    options: FauxModelOptions = {},
): Promise<AgentE2EHandle> => {
    const cwd = path.resolve(process.cwd());
    await assertExtensionBuildReady(cwd);
    const provider = options.provider ?? 'faux';
    const model = options.model ?? 'faux-model';
    const faux = await startFauxModel({...options, provider, model});

    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-e2e-agent-'));
    const userDataDir = path.join(tempRoot, 'user-data');
    const endpoint = path.join(tempRoot, 'agent.sock');
    await fs.mkdir(userDataDir, {recursive: true});
    const keepTemp = process.env.RPA_E2E_KEEP_TEMP === '1';

    const proc = spawn('pnpm', ['dev:headless'], {
        cwd: path.resolve(process.cwd()),
        env: {
            ...process.env,
            RPA_CONTROL_EVAL: '1',
            RPA_CONTROL_ENDPOINT: endpoint,
            RPA_USER_DATA_DIR: userDataDir,
            RPA_WORKFLOW_ROOT: path.join(tempRoot, 'workflow'),
            RPA_AGENT_API_KEY: 'test-key',
            RUNNER_AGENT_PROVIDER: provider,
            RUNNER_AGENT_MODEL: model,
            RUNNER_AGENT_BASE_URL: faux.baseUrl,
            RUNNER_AGENT_INTERACTION: 'headless',
            RUNNER_AGENT_SESSION_STORAGE_ROOT: path.join(tempRoot, 'sessions'),
            RUNNER_AGENT_REPORT_ROOT: path.join(tempRoot, 'reports'),
        },
        stdio: 'pipe',
    });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 12_000) {stderr = stderr.slice(-12_000);}
    });

    const waitAgentReady = async () => {
        const deadline = Date.now() + 40_000;
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
        throw new Error(`agent startup timeout (control endpoint not ready)\n${stderr}`);
    };

    await waitAgentReady();

    return {
        endpoint,
        model: {provider, model},
        faux,
        close: async () => {
            try {
                await faux.close();
            } catch {
                // ignore close errors; the mock is best-effort
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
                    console.log(`[e2e-agent] temp kept at ${tempRoot}`);
                } else {
                    await fs.rm(tempRoot, {recursive: true, force: true}).catch(() => undefined);
                }
            }
        },
    };
};