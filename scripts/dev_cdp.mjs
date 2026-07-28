import console from 'node:console';
import {watch} from 'node:fs';
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
const lockDir = path.resolve(process.env.RPA_DEV_CDP_LOCK_DIR || path.join(root, '.dev', 'dev-cdp.lock'));
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const watchedPaths = [
    'extension/src',
    'extension/manifest.json',
    'extension/build.mjs',
    'extension/vite.config.ts',
    'start_extension/src',
    'start_extension/manifest.json',
    'start_extension/build.mjs',
    'start_extension/newtab.html',
].map((entry) => path.join(root, entry));

const instanceLock = await acquireInstanceLock({lockDir});
let activeBuild = null;
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
        const children = [activeBuild, agent].filter(Boolean);
        await Promise.all(children.map(async (child) => {
            await terminateProcessTree(child, {signal, killAfterMs: 3000});
        }));
        activeBuild = null;
        agent = null;
        instanceLock.release();
        process.exitCode = exitCode;
    })();
    return shutdownPromise;
};

process.once('exit', () => {
    terminateProcessTreeSync(activeBuild);
    terminateProcessTreeSync(agent);
    instanceLock.release();
});
process.once('SIGINT', () => {void shutdown('SIGINT', 130);});
process.once('SIGTERM', () => {void shutdown('SIGTERM', 143);});

const runBuild = () => new Promise((resolve, reject) => {
    const child = spawnManagedProcess(pnpmCommand, ['build:extension'], {
        cwd: root,
        stdio: 'inherit',
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
        reject(new Error(`extension build failed: code=${String(code)} signal=${String(signal)}`));
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
            await runBuild();
        } while (rebuildQueued && !stopping);
    } catch (error) {
        if (!stopping) {console.error('[rpa-extension] rebuild failed', error);}
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

try {
    await runBuild();
    if (stopping) {
        await shutdownPromise;
    } else {
        agent = spawnManagedProcess(pnpmCommand, ['--filter', './agent', 'dev:cdp'], {
            cwd: root,
            env: {...process.env, RPA_EXTENSION_AUTO_RELOAD: 'true'},
            stdio: 'inherit',
        });
        agent.once('error', (error) => {
            console.error('[rpa-extension] agent failed to start', error);
            void shutdown('SIGTERM', 1);
        });
        agent.once('exit', (code, signal) => {
            if (stopping) {return;}
            const exitCode = signal ? 1 : (code ?? 1);
            void shutdown('SIGTERM', exitCode);
        });

        for (const target of watchedPaths) {
            try {
                watchers.push(watch(target, {recursive: true}, scheduleRebuild));
            } catch (error) {
                console.error(`[rpa-extension] cannot watch ${target}`, error);
            }
        }
    }
} catch (error) {
    if (!stopping) {
        console.error('[rpa-extension] startup failed', error);
        await shutdown('SIGTERM', 1);
    }
}
