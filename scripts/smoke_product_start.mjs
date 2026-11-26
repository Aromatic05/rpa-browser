import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnPnpm, terminateProcessTree} from './dev_cdp_runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const smokeRoot = await mkdtemp(path.join(os.tmpdir(), 'rpa-product-start-'));
const sessions = path.join(smokeRoot, 'sessions');
const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\${path.basename(smokeRoot)}`
    : path.join(smokeRoot, 'agent.sock');

let child;
try {
    child = spawnPnpm(['start'], {
        cwd: root,
        env: {
            ...process.env,
            RPA_HEADLESS: 'true',
            RPA_CONTROL_EVAL: '0',
            RPA_CONTROL_ENDPOINT: endpoint,
            RPA_RUNTIME_PORT_BASE: process.env.RPA_SMOKE_PORT_BASE || '34600',
            RPA_RUNTIME_LOCK_DIR: path.join(smokeRoot, 'lock'),
            RPA_USER_DATA_DIR: path.join(smokeRoot, 'profile'),
            RPA_WORKFLOW_ROOT: path.join(smokeRoot, 'workflows'),
            RUNNER_AGENT_SESSION_STORAGE_ROOT: sessions,
            RUNNER_AGENT_REPORT_ROOT: path.join(sessions, 'reports'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        windowsHide: true,
    });
    const signal = AbortSignal.timeout(45_000);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk) => {stderr = (stderr + chunk.toString()).slice(-12_000);});
    try {
        await Promise.race([
            (async () => {
                for await (const chunk of child.stdout) {
                    stdout = (stdout + chunk.toString()).slice(-12_000);
                    if (stdout.includes(`[rpa-agent] ready: control=${endpoint}`)) {return;}
                }
                throw new Error('Agent output closed before readiness');
            })(),
            once(child, 'exit', {signal}).then(([code, exitSignal]) => {
                throw new Error(`pnpm start exited before readiness (${code ?? exitSignal})`);
            }),
        ]);
    } catch (error) {
        throw new Error(`Product startup smoke failed\n${stdout}\n${stderr}`, {cause: error});
    }
    assert.equal(child.exitCode, null);
    console.log('Product runtime reached Agent readiness with headless Chromium.');
} finally {
    await terminateProcessTree(child, {signal: 'SIGKILL', killAfterMs: 5000});
    await rm(smokeRoot, {recursive: true, force: true, maxRetries: 8});
}
