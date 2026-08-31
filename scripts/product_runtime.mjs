import console from 'node:console';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';

import {
    acquireInstanceLock,
    spawnManagedProcess,
    terminateProcessTree,
    terminateProcessTreeSync,
} from './dev_cdp_runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentRoot = path.join(root, 'agent');
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const lockDir = path.resolve(
    process.env.RPA_RUNTIME_LOCK_DIR
    || path.join(agentRoot, '.rpa', 'runtime.lock'),
);
const stampPath = path.join(root, '.dev', 'extension-build.json');
const runnerBundlePath = path.join(agentRoot, '.runner-dist', 'plugin.mjs');
const agentBundlePath = path.join(agentRoot, '.dist', 'agent.mjs');
const recorderPayloadBundlePath = path.join(agentRoot, '.dist', 'resources', 'recording', 'payload.bundle.js');

let instanceLock = null;
let buildProcess = null;
let agentProcess = null;
let stopping = false;
let shutdownPromise = null;

const extensionBuildReady = () => {
    try {
        const stamp = JSON.parse(readFileSync(stampPath, 'utf8'));
        return typeof stamp.mainExtensionPath === 'string'
            && stamp.mainExtensionPath.length > 0
            && existsSync(path.resolve(stamp.mainExtensionPath));
    } catch {
        return false;
    }
};

const productBuildReady = () =>
    extensionBuildReady()
    && existsSync(runnerBundlePath)
    && existsSync(agentBundlePath)
    && existsSync(recorderPayloadBundlePath);

const runPnpm = (args) => new Promise((resolve, reject) => {
    const child = spawnManagedProcess(pnpmCommand, args, {
        cwd: root,
        stdio: 'inherit',
        detached: false,
    });
    buildProcess = child;
    child.once('error', (error) => {
        if (buildProcess === child) {buildProcess = null;}
        reject(error);
    });
    child.once('exit', (code, signal) => {
        if (buildProcess === child) {buildProcess = null;}
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(`product build failed: pnpm ${args.join(' ')} code=${String(code)} signal=${String(signal)}`));
    });
});

const ensureProductBuild = async () => {
    if (productBuildReady()) {return;}
    console.warn('[rpa] product artifacts are missing; building them once');
    await runPnpm(['build:product']);
    if (!productBuildReady()) {
        throw new Error('product build completed without the extension or runner artifact');
    }
};

const shutdown = (signal = 'SIGTERM', exitCode = 0) => {
    if (shutdownPromise) {return shutdownPromise;}
    stopping = true;
    shutdownPromise = (async () => {
        await Promise.all([
            terminateProcessTree(buildProcess, {signal, killAfterMs: 3000}),
            terminateProcessTree(agentProcess, {signal, killAfterMs: 3000}),
        ]);
        buildProcess = null;
        agentProcess = null;
        instanceLock?.release();
        instanceLock = null;
        process.exitCode = exitCode;
    })();
    return shutdownPromise;
};

const startAgent = () => {
    const child = spawnManagedProcess(
        process.execPath,
        [agentBundlePath],
        {
            cwd: agentRoot,
            env: {
                ...process.env,
                NODE_ENV: 'production',
                RPA_EXTENSION_AUTO_RELOAD: 'false',
                RPA_REPOSITORY_ROOT: root,
                RPA_RECORDER_PAYLOAD_BUNDLE: recorderPayloadBundlePath,
            },
            stdio: 'inherit',
            detached: false,
        },
    );
    agentProcess = child;
    child.once('error', (error) => {
        if (stopping || agentProcess !== child) {return;}
        console.error('[rpa] Agent failed to start:', error);
        void shutdown('SIGTERM', 1);
    });
    child.once('exit', (code, signal) => {
        if (stopping || agentProcess !== child) {return;}
        console.error('[rpa] Agent exited', {code, signal});
        agentProcess = null;
        void shutdown('SIGTERM', signal ? 1 : (code === 0 ? 1 : (code ?? 1)));
    });
};

const beginSignalShutdown = (signal, exitCode) => {
    if (stopping) {return;}
    stopping = true;
    terminateProcessTreeSync(buildProcess, 'SIGTERM');
    terminateProcessTreeSync(agentProcess, 'SIGTERM');
    instanceLock?.release();
    instanceLock = null;
    void shutdown('SIGTERM', exitCode);
};

const main = async () => {
    try {
        instanceLock = await acquireInstanceLock({lockDir, runtimeName: 'RPA Browser'});
        await ensureProductBuild();
        startAgent();
        console.warn('[rpa] product runtime starting');
    } catch (error) {
        console.error('[rpa] startup failed:', error instanceof Error ? error.message : String(error));
        await shutdown('SIGTERM', 1);
    }
};

process.once('exit', () => {
    terminateProcessTreeSync(buildProcess);
    terminateProcessTreeSync(agentProcess);
    instanceLock?.release();
});
process.once('SIGINT', () => {beginSignalShutdown('SIGINT', 130);});
process.once('SIGTERM', () => {beginSignalShutdown('SIGTERM', 143);});

await main();
