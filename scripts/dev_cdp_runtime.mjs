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

export const acquireInstanceLock = async ({lockDir, pid = process.pid, runtimeName = 'RPA development runtime'} = {}) => {
    if (!lockDir) {throw new Error('development runtime lock directory is required');}
    await mkdir(path.dirname(lockDir), {recursive: true});

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            await mkdir(lockDir);
        } catch (error) {
            if (error?.code !== 'EEXIST') {throw error;}
            const owner = await readLockOwner(lockDir);
            if (owner && isProcessAlive(owner.pid)) {
                const started = owner.startedAt ? `, started ${owner.startedAt}` : '';
                throw new Error(`${runtimeName} is already running (pid ${owner.pid}${started})`, {cause: error});
            }
            if (!owner && await lockIsInitializing(lockDir)) {
                throw new Error(`${runtimeName} is already starting; lock owner is not available yet`, {cause: error});
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

    throw new Error(`failed to acquire ${runtimeName} instance lock: ${lockDir}`);
};

const managedProcessDetached = new WeakMap();

export const spawnManagedProcess = (command, args, options = {}) => {
    const detached = options.detached ?? process.platform !== 'win32';
    const spawnOptions = {...options};
    delete spawnOptions.detached;
    const child = spawn(command, args, {
        ...spawnOptions,
        detached,
    });
    managedProcessDetached.set(child, detached);
    return child;
};

const descendantProcessIds = (rootPid) => {
    if (!rootPid || process.platform === 'win32') {return [];}
    const result = spawnSync('ps', ['-eo', 'pid=,ppid='], {encoding: 'utf8'});
    if (result.status !== 0) {return [];}
    const childrenByParent = new Map();
    for (const line of result.stdout.split(/\r?\n/)) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (!match) {continue;}
        const pid = Number(match[1]);
        const parentPid = Number(match[2]);
        const children = childrenByParent.get(parentPid) ?? [];
        children.push(pid);
        childrenByParent.set(parentPid, children);
    }
    const descendants = [];
    const visit = (pid) => {
        for (const childPid of childrenByParent.get(pid) ?? []) {
            visit(childPid);
            descendants.push(childPid);
        }
    };
    visit(rootPid);
    return descendants;
};

const signalPid = (pid, signal) => {
    try {process.kill(pid, signal);} catch (error) {
        if (error?.code !== 'ESRCH') {throw error;}
    }
};

const signalProcessTree = (child, signal) => {
    if (!child?.pid) {return;}
    if (process.platform === 'win32') {
        if (child.exitCode !== null) {return;}
        const args = ['/pid', String(child.pid), '/t'];
        if (signal === 'SIGKILL') {args.push('/f');}
        spawnSync('taskkill', args, {stdio: 'ignore'});
        return;
    }
    if (managedProcessDetached.get(child) === false) {
        for (const pid of descendantProcessIds(child.pid)) {signalPid(pid, signal);}
        signalPid(child.pid, signal);
        return;
    }
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error?.code !== 'ESRCH' && child.exitCode === null) {
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
    if (!child?.pid) {return;}
    const pid = child.pid;
    if (process.platform === 'win32') {
        if (child.exitCode !== null) {return;}
        let exited = false;
        child.once('exit', () => {exited = true;});
        signalProcessTree(child, signal);
        const deadline = Date.now() + killAfterMs;
        while (!exited && Date.now() < deadline) {await sleep(25);}
        if (!exited) {signalProcessTree(child, 'SIGKILL');}
        return;
    }

    if (managedProcessDetached.get(child) === false) {
        const targets = [...descendantProcessIds(pid), pid];
        if (!targets.some(isProcessAlive)) {return;}
        signalProcessTree(child, signal);
        const deadline = Date.now() + killAfterMs;
        while (targets.some(isProcessAlive) && Date.now() < deadline) {await sleep(25);}
        if (targets.some(isProcessAlive)) {
            for (const targetPid of targets) {signalPid(targetPid, 'SIGKILL');}
        }
        return;
    }

    if (!isProcessGroupAlive(pid)) {return;}
    signalProcessTree(child, signal);
    const deadline = Date.now() + killAfterMs;
    while (isProcessGroupAlive(pid) && Date.now() < deadline) {await sleep(25);}
    if (isProcessGroupAlive(pid)) {
        signalProcessTree(child, 'SIGKILL');
        const killDeadline = Date.now() + Math.min(killAfterMs, 1000);
        while (isProcessGroupAlive(pid) && Date.now() < killDeadline) {await sleep(25);}
    }
};
