import {spawn} from 'node:child_process';
import {watch} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

const runBuild = () => new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['build:extension'], {cwd: root, stdio: 'inherit'});
    child.once('error', reject);
    child.once('exit', (code, signal) => {
        if (code === 0) {
            resolve();
            return;
        }
        reject(new Error(`extension build failed: code=${String(code)} signal=${String(signal)}`));
    });
});

await runBuild();

const agent = spawn('pnpm', ['--filter', './agent', 'dev:cdp'], {
    cwd: root,
    env: {...process.env, RPA_EXTENSION_AUTO_RELOAD: 'true'},
    stdio: 'inherit',
});

let timer = null;
let building = false;
let rebuildQueued = false;
let stopping = false;
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
        console.error('[rpa-extension] rebuild failed', error);
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

const watchers = [];
for (const target of watchedPaths) {
    try {
        watchers.push(watch(target, {recursive: true}, scheduleRebuild));
    } catch (error) {
        console.error(`[rpa-extension] cannot watch ${target}`, error);
    }
}

const stop = (signal) => {
    if (stopping) {return;}
    stopping = true;
    if (timer) {clearTimeout(timer);}
    for (const watcher of watchers) {watcher.close();}
    if (agent.exitCode === null) {agent.kill(signal);}
};
process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
agent.once('error', (error) => {
    console.error('[rpa-extension] agent failed to start', error);
    stop('SIGTERM');
    process.exitCode = 1;
});
agent.once('exit', (code, signal) => {
    stop('SIGTERM');
    if (signal) {
        process.kill(process.pid, signal);
        return;
    }
    process.exitCode = code ?? 1;
});
