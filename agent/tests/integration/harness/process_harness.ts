import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const waitForLine = (proc: ChildProcess, pattern: RegExp, timeoutMs = 30000) =>
    new Promise<void>((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => {
            reject(new Error(`timeout waiting for pattern: ${pattern}\\n${out}`));
        }, timeoutMs);
        const onChunk = (chunk: Buffer | string) => {
            const text = String(chunk);
            out += text;
            if (pattern.test(out)) {
                clearTimeout(timer);
                cleanup();
                resolve();
            }
        };
        const onExit = () => {
            clearTimeout(timer);
            cleanup();
            reject(new Error(`process exited before ready: ${pattern}\\n${out}`));
        };
        const cleanup = () => {
            proc.stdout?.off('data', onChunk);
            proc.stderr?.off('data', onChunk);
            proc.off('exit', onExit);
        };
        proc.stdout?.on('data', onChunk);
        proc.stderr?.on('data', onChunk);
        proc.on('exit', onExit);
    });

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
    const verbose =
        String(process.env.RPA_INTEGRATION_VERBOSE || (opts?.headed ? 'true' : 'false')).toLowerCase() === 'true';

    const mockProc = spawn('node', ['mock/server.js'], {
        cwd: repoRoot,
        env: { ...process.env, MOCK_PORT: String(mockPort) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    pipeProcLogs(mockProc, '[integration:mock]', verbose);
    await waitForLine(mockProc, /\[mock\] server listening/i, 20000);

    const env = {
        ...process.env,
        RPA_HEADLESS: opts?.headed ? 'false' : 'true',
        RPA_WS_PORT: String(wsPort),
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
        await waitForLine(agentProc, /WS listening on ws:\/\/127\.0\.0\.1:/, 45000);
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
        },
    };
};
