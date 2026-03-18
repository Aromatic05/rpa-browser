import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { WebSocket } from 'ws';

const reservePort = async () =>
    new Promise<number>((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address === 'string' || !address) {
                server.close();
                reject(new Error('failed to allocate ws port'));
                return;
            }
            const { port } = address;
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });

const waitForPort = async (host: string, port: number, timeoutMs = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await new Promise<boolean>((resolve) => {
            const socket = net.createConnection({ host, port });
            socket.once('connect', () => {
                socket.end();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
            socket.setTimeout(1500, () => {
                socket.destroy();
                resolve(false);
            });
        });
        if (ok) return;
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`timeout waiting for tcp port ${host}:${port}`);
};

const waitForWsReady = async (url: string, timeoutMs = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const result = await new Promise<boolean>((resolve) => {
            const ws = new WebSocket(url);
            const actionId = crypto.randomUUID();
            const timer = setTimeout(() => {
                try {
                    ws.close();
                } catch {
                    // ignore
                }
                resolve(false);
            }, 3000);
            ws.on('open', () => {
                ws.send(
                    JSON.stringify({
                        v: 1,
                        id: actionId,
                        type: 'workspace.list',
                    }),
                );
            });
            ws.on('message', (raw) => {
                try {
                    const packet = JSON.parse(String(raw));
                    if (packet?.replyTo === actionId && packet?.payload) {
                        clearTimeout(timer);
                        ws.close();
                        resolve(true);
                    }
                } catch {
                    // ignore non-json packet
                }
            });
            ws.on('error', () => {
                clearTimeout(timer);
                resolve(false);
            });
            ws.on('close', () => clearTimeout(timer));
        });
        if (result) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timeout waiting for ws ready: ${url}`);
};

const pipeProcLogs = (proc: ChildProcess, prefix: string, enabled: boolean) => {
    if (!enabled) return;
    const write = (stream: NodeJS.WriteStream, chunk: Buffer | string) => {
        const text = String(chunk);
        const lines = text.split('\n');
        for (const line of lines) {
            if (!line.trim()) continue;
            stream.write(`${prefix} ${line}\n`);
        }
    };
    proc.stdout?.on('data', (chunk) => write(process.stdout, chunk));
    proc.stderr?.on('data', (chunk) => write(process.stderr, chunk));
};

export const startAgentStack = async (opts?: { headed?: boolean; fixtureBaseUrl?: string }) => {
    const repoRoot = path.resolve(process.cwd(), '..');
    const extensionAwareDefault = opts?.headed ? 'true' : 'false';
    const extensionAware =
        String(process.env.RPA_INTEGRATION_EXTENSION_AWARE || extensionAwareDefault).toLowerCase() === 'true';
    const preferredWsPort = Number(process.env.RPA_INTEGRATION_WS_PORT || 17333);
    const wsPort = extensionAware ? preferredWsPort : await reservePort();
    const mockPort = await reservePort();
    const userDataDir = path.join(
        os.tmpdir(),
        `rpa-agent-integration-user-data-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    const verbose =
        String(process.env.RPA_INTEGRATION_VERBOSE || (opts?.headed ? 'true' : 'false')).toLowerCase() === 'true';

    const mockProc = spawn('node', ['mock/server.js'], {
        cwd: repoRoot,
        env: { ...process.env, MOCK_PORT: String(mockPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeProcLogs(mockProc, '[integration:mock]', verbose);
    await waitForPort('127.0.0.1', mockPort, 20000);

    const env = {
        ...process.env,
        RPA_HEADLESS: opts?.headed ? 'false' : 'true',
        RPA_WS_PORT: String(wsPort),
        RPA_USER_DATA_DIR: userDataDir,
    } as Record<string, string>;
    if (opts?.fixtureBaseUrl) {
        env.RPA_START_URL = `${opts.fixtureBaseUrl}/run_steps_fixture_a.html`;
        env.RPA_NEWTAB_URL = `${opts.fixtureBaseUrl}/run_steps_fixture_a.html`;
    }
    const agentProc = spawn('node', ['--import', 'tsx', 'src/index.ts'], {
        cwd: path.join(repoRoot, 'agent'),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeProcLogs(agentProc, '[integration:agent]', verbose);
    try {
        await waitForPort('127.0.0.1', wsPort, 45000);
        await waitForWsReady(`ws://127.0.0.1:${wsPort}`, 45000);
    } catch (error) {
        if (!agentProc.killed && agentProc.exitCode == null) {
            agentProc.kill('SIGTERM');
        }
        if (!mockProc.killed && mockProc.exitCode == null) {
            mockProc.kill('SIGTERM');
        }
        throw error;
    }

    return {
        wsUrl: `ws://127.0.0.1:${wsPort}`,
        stop: async () => {
            const killOne = (proc: ChildProcess) =>
                new Promise<void>((resolve) => {
                    if (proc.killed || proc.exitCode != null) return resolve();
                    proc.once('exit', () => resolve());
                    proc.kill('SIGTERM');
                    setTimeout(() => {
                        if (proc.exitCode == null) proc.kill('SIGKILL');
                    }, 5000);
                });
            await killOne(agentProc);
            await killOne(mockProc);
            await fs.rm(userDataDir, { recursive: true, force: true }).catch(() => undefined);
        },
    };
};
