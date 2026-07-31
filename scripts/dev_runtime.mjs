import console from 'node:console';
import {existsSync, watch} from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import {clearTimeout, setTimeout} from 'node:timers';
import {fileURLToPath} from 'node:url';

import {
    acquireInstanceLock,
    spawnManagedProcess,
    terminateProcessTree,
    terminateProcessTreeSync,
} from './dev_cdp_runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv.find((arg) => arg.startsWith('--mode='))?.slice('--mode='.length) || 'extension';
if (mode !== 'extension' && mode !== 'cdp') {
    throw new Error(`unsupported development runtime mode: ${mode}`);
}

const lockDir = path.resolve(
    process.env.RPA_DEV_RUNTIME_LOCK_DIR
    || process.env.RPA_DEV_CDP_LOCK_DIR
    || path.join(root, '.dev', 'dev-runtime.lock'),
);
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const watchedPaths = [
    'extension/src',
    'extension/manifest.json',
    'extension/build.mjs',
    'start_extension/src',
    'start_extension/manifest.json',
    'start_extension/build.mjs',
    'start_extension/newtab.html',
].map((entry) => path.join(root, entry)).filter(existsSync);

let instanceLock = null;
let activeBuild = null;
let runnerWatch = null;
let agent = null;
let timer = null;
let building = false;
let rebuildQueued = false;
let stopping = false;
let shutdownPromise = null;
const watchers = [];

const closeWatchers = () => {
    if (timer) {
        clearTimeout(timer);
        timer = null;
    }
    for (const watcher of watchers.splice(0)) {watcher.close();}
};

const shutdown = (signal = 'SIGTERM', exitCode = 0) => {
    if (shutdownPromise) {return shutdownPromise;}
    stopping = true;
    rebuildQueued = false;
    closeWatchers();
    shutdownPromise = (async () => {
        const children = [activeBuild, runnerWatch, agent].filter(Boolean);
        await Promise.all(children.map(async (child) => {
            await terminateProcessTree(child, {signal, killAfterMs: 3000});
        }));
        activeBuild = null;
        runnerWatch = null;
        agent = null;
        instanceLock?.release();
        instanceLock = null;
        process.exitCode = exitCode;
    })();
    return shutdownPromise;
};

const runCommand = (args) => new Promise((resolve, reject) => {
    const child = spawnManagedProcess(pnpmCommand, args, {
        cwd: root,
        stdio: 'inherit',
        detached: false,
    });
    activeBuild = child;
    child.once('error', (error) => {
        if (activeBuild === child) {activeBuild = null;}
        reject(error);
    });
    child.once('exit', (code, signal) => {
        if (activeBuild === child) {activeBuild = null;}
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(`command failed: pnpm ${args.join(' ')} code=${String(code)} signal=${String(signal)}`));
    });
});

const rebuild = async () => {
    if (building) {
        rebuildQueued = true;
        return;
    }
    building = true;
    try {
        do {
            rebuildQueued = false;
            await runCommand(['build:extension']);
            if (agent && !stopping) {
                console.info('[rpa-dev] extension build changed; restarting agent');
                await restartAgent();
            }
        } while (rebuildQueued && !stopping);
    } catch (error) {
        if (!stopping) {console.error('[rpa-dev] extension rebuild failed', error);}
    } finally {
        building = false;
    }
};

const scheduleRebuild = () => {
    if (stopping) {return;}
    if (timer) {clearTimeout(timer);}
    timer = setTimeout(() => {
        timer = null;
        void rebuild();
    }, 180);
};

const monitorChild = (child, label, isCurrent = () => true) => {
    child.once('error', (error) => {
        if (stopping || !isCurrent()) {return;}
        console.error(`[rpa-dev] ${label} failed to start`, error);
        void shutdown('SIGTERM', 1);
    });
    child.once('exit', (code, signal) => {
        if (stopping || !isCurrent()) {return;}
        console.error(`[rpa-dev] ${label} exited`, {code, signal});
        void shutdown('SIGTERM', signal ? 1 : (code ?? 1));
    });
};

const startAgent = () => {
    const agentScript = mode === 'cdp' ? 'dev:cdp' : 'dev';
    const child = spawnManagedProcess(pnpmCommand, ['--filter', './agent', agentScript], {
        cwd: root,
        env: {...process.env, RPA_EXTENSION_AUTO_RELOAD: 'false'},
        stdio: 'inherit',
        detached: false,
    });
    agent = child;
    monitorChild(child, 'agent', () => agent === child);
};

const restartAgent = async () => {
    const previous = agent;
    agent = null;
    if (previous) {
        await terminateProcessTree(previous, {signal: 'SIGTERM', killAfterMs: 3000});
    }
    if (!stopping) {startAgent();}
};

const main = async () => {
    try {
        instanceLock = await acquireInstanceLock({lockDir});
        await runCommand(['build:extension']);
        await runCommand(['--filter', './agent', 'test:runner:bundle']);

        runnerWatch = spawnManagedProcess(pnpmCommand, ['--filter', './agent', 'test:runner:bundle:watch'], {
            cwd: root,
            stdio: 'inherit',
            detached: false,
        });
        monitorChild(runnerWatch, 'runner bundle watcher');

        startAgent();

        for (const target of watchedPaths) {
            watchers.push(watch(target, {recursive: true}, scheduleRebuild));
        }
        console.info(`[rpa-dev] ${mode} runtime starting; waiting for agent readiness`);
    } catch (error) {
        console.error('[rpa-dev] startup failed:', error instanceof Error ? error.message : String(error));
        await shutdown('SIGTERM', 1);
    }
};

const beginSignalShutdown = (signal, exitCode) => {
    if (stopping) {return;}
    stopping = true;
    rebuildQueued = false;
    closeWatchers();
    console.info(`[rpa-dev] shutdown requested: ${signal}`);
    terminateProcessTreeSync(activeBuild, 'SIGTERM');
    terminateProcessTreeSync(runnerWatch, 'SIGTERM');
    terminateProcessTreeSync(agent, 'SIGTERM');
    instanceLock?.release();
    instanceLock = null;
    void shutdown('SIGTERM', exitCode).finally(() => {
        process.exitCode = exitCode;
    });
};

process.once('exit', () => {
    terminateProcessTreeSync(activeBuild);
    terminateProcessTreeSync(runnerWatch);
    terminateProcessTreeSync(agent);
    instanceLock?.release();
});
process.once('SIGINT', () => {beginSignalShutdown('SIGINT', 130);});
process.once('SIGTERM', () => {beginSignalShutdown('SIGTERM', 143);});

await main();
