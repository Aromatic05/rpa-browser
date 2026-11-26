import {execFile, spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {promisify} from 'node:util';

export const e2eControlEndpoint = (tempRoot: string): string =>
    process.platform === 'win32'
        ? `\\\\.\\pipe\\rpa-e2e-${randomUUID()}`
        : path.join(tempRoot, 'agent.sock');

export const spawnE2eAgent = (options: {cwd: string; env: NodeJS.ProcessEnv; headed?: boolean}) =>
    spawn(process.execPath, ['--import', 'tsx', 'src/app/entrypoints/agent.ts'], {
        cwd: options.cwd,
        env: {...options.env, RPA_HEADLESS: options.headed ? 'false' : 'true'},
        stdio: 'pipe',
    });

export const stopE2eAgent = async (child: ChildProcess): Promise<void> => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) {return;}
    if (process.platform === 'win32') {
        // Killing Node alone leaves Chromium running and holding the test profile open.
        try {
            await promisify(execFile)('taskkill', ['/pid', String(child.pid), '/t', '/f'], {windowsHide: true});
        } catch (error) {
            if (child.exitCode === null && child.signalCode === null) {throw error;}
        }
        return;
    }
    child.kill('SIGTERM');
    const deadline = Date.now() + 3000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await sleep(25);
    }
    if (child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL');}
};
