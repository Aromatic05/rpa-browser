import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {mkdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {setTimeout} from 'node:timers';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const isProcessAlive = (pid) => {
    if (!Number.isInteger(pid) || pid <= 0) {return false;}
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
};

const readLockOwner = async (lockDir) => {
    try {
        const raw = await readFile(path.join(lockDir, 'owner.json'), 'utf8');
        const owner = JSON.parse(raw);
        return Number.isInteger(owner?.pid) && owner.pid > 0 ? owner : null;
    } catch {
        return null;
    }
};

const lockIsInitializing = async (lockDir) => {
    try {
        const info = await stat(lockDir);
        return Date.now() - info.mtimeMs < 5000;
    } catch {
        return false;
    }
};

export const acquireInstanceLock = async ({lockDir, pid = process.pid} = {}) => {
    if (!lockDir) {throw new Error('dev:cdp lock directory is required');}
    await mkdir(path.dirname(lockDir), {recursive: true});

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDir);
        } catch (error) {
            if (error?.code !== 'EEXIST') {throw error;}
            const owner = await readLockOwner(lockDir);
            if (owner && isProcessAlive(owner.pid)) {
                const started = owner.startedAt ? `, started ${owner.startedAt}` : '';
                throw new Error(`pnpm dev:cdp is already running (pid ${owner.pid}${started})`, {cause: error});
            }
            if (!owner && await lockIsInitializing(lockDir)) {
                throw new Error('pnpm dev:cdp is already starting; lock owner is not available yet', {cause: error});
            }
            await rm(lockDir, {recursive: true, force: true});
            continue;
        }

        const owner = {
            pid,
            startedAt: new Date().toISOString(),
        };
        try {
            await writeFile(path.join(lockDir, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, 'utf8');
        } catch (error) {
            await rm(lockDir, {recursive: true, force: true});
            throw error;
        }

        let released = false;
        const release = () => {
            if (released) {return;}
            released = true;
            try {
                const raw = fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8');
                const current = JSON.parse(raw);
                if (current?.pid !== pid) {return;}
            } catch {
                return;
            }
            fs.rmSync(lockDir, {recursive: true, force: true});
        };
        return {lockDir, pid, release};
    }

    throw new Error(`failed to acquire dev:cdp instance lock: ${lockDir}`);
};

export const spawnManagedProcess = (command, args, options = {}) =>
    spawn(command, args, {
        ...options,
        detached: process.platform !== 'win32',
    });

const signalProcessTree = (child, signal) => {
    if (!child?.pid || child.exitCode !== null) {return;}
    if (process.platform === 'win32') {
        const args = ['/pid', String(child.pid), '/t'];
        if (signal === 'SIGKILL') {args.push('/f');}
        spawnSync('taskkill', args, {stdio: 'ignore'});
        return;
    }
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error?.code !== 'ESRCH') {
            try {child.kill(signal);} catch { /* process already exited */ }
        }
    }
};

const isProcessGroupAlive = (pid) => {
    if (!pid || process.platform === 'win32') {return false;}
    try {
        process.kill(-pid, 0);
        return true;
    } catch (error) {
        return error?.code === 'EPERM';
    }
};

export const terminateProcessTreeSync = (child, signal = 'SIGKILL') => {
    signalProcessTree(child, signal);
};

export const terminateProcessTree = async (
    child,
    {signal = 'SIGTERM', killAfterMs = 3000} = {},
) => {
    if (!child?.pid || child.exitCode !== null) {return;}
    const pid = child.pid;
    let exited = false;
    const exitPromise = new Promise((resolve) => {
        child.once('exit', () => {
            exited = true;
            resolve();
        });
    });

    signalProcessTree(child, signal);
    const deadline = Date.now() + killAfterMs;
    while (Date.now() < deadline) {
        if (process.platform === 'win32') {
            if (exited) {break;}
        } else if (!isProcessGroupAlive(pid)) {
            break;
        }
        await sleep(25);
    }

    if ((process.platform === 'win32' && !exited) ||
        (process.platform !== 'win32' && isProcessGroupAlive(pid))) {
        signalProcessTree(child, 'SIGKILL');
    }
    if (!exited) {await exitPromise;}
};
