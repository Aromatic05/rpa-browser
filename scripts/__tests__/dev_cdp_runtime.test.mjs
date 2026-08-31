import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {setTimeout} from 'node:timers';

import {
    acquireInstanceLock,
    isProcessAlive,
    spawnManagedProcess,
    terminateProcessTree,
} from '../dev_cdp_runtime.mjs';

const withTempDir = async (run) => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'rpa-dev-cdp-test-'));
    try {
        await run(tempDir);
    } finally {
        await rm(tempDir, {recursive: true, force: true});
    }
};

const waitFor = async (predicate, timeoutMs = 3000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) {return;}
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail('condition was not met before timeout');
};

const readPidFile = async (filePath) => {
    try {
        const pid = Number((await readFile(filePath, 'utf8')).trim());
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
        return null;
    }
};

test('dev:cdp instance lock rejects a second live owner', async () => {
    await withTempDir(async (tempDir) => {
        const lockDir = path.join(tempDir, 'dev-cdp.lock');
        const first = await acquireInstanceLock({lockDir});
        await assert.rejects(
            acquireInstanceLock({lockDir}),
            new RegExp(`already running.*pid ${process.pid}`, 'i'),
        );
        first.release();
    });
});

test('dev:cdp instance lock reclaims a stale owner', async () => {
    await withTempDir(async (tempDir) => {
        const lockDir = path.join(tempDir, 'dev-cdp.lock');
        await mkdir(lockDir, {recursive: true});
        await writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: 99999999,
            startedAt: '2000-01-01T00:00:00.000Z',
        }));

        const lock = await acquireInstanceLock({lockDir});
        const owner = JSON.parse(await readFile(path.join(lockDir, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        lock.release();
    });
});

test('terminating the managed process kills its descendants', {
    skip: process.platform === 'win32',
}, async () => {
    await withTempDir(async (tempDir) => {
        const pidFile = path.join(tempDir, 'grandchild.pid');
        const childSource = [
            "const {spawn} = require('node:child_process');",
            "const {writeFileSync} = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});",
            `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
            'setInterval(() => {}, 1000);',
        ].join('\n');
        const child = spawnManagedProcess(process.execPath, ['-e', childSource], {stdio: 'ignore'});
        await waitFor(async () => (await readPidFile(pidFile)) !== null);
        const grandchildPid = await readPidFile(pidFile);
        assert.ok(grandchildPid);

        assert.equal(isProcessAlive(child.pid), true);
        assert.equal(isProcessAlive(grandchildPid), true);
        await terminateProcessTree(child, {signal: 'SIGINT', killAfterMs: 500});
        await waitFor(() => !isProcessAlive(child.pid) && !isProcessAlive(grandchildPid));
    });
});

test('terminating a managed process still kills descendants after the group leader exits', {
    skip: process.platform === 'win32',
}, async () => {
    await withTempDir(async (tempDir) => {
        const pidFile = path.join(tempDir, 'grandchild.pid');
        const childSource = [
            "const {spawn} = require('node:child_process');",
            "const {writeFileSync} = require('node:fs');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});",
            'child.unref();',
            `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
        ].join('\n');
        const child = spawnManagedProcess(process.execPath, ['-e', childSource], {stdio: 'ignore'});
        const childExit = child.exitCode !== null
            ? Promise.resolve()
            : new Promise((resolve) => child.once('exit', resolve));
        await waitFor(async () => (await readPidFile(pidFile)) !== null);
        const grandchildPid = await readPidFile(pidFile);
        assert.ok(grandchildPid);
        await childExit;
        assert.equal(isProcessAlive(grandchildPid), true);
        await terminateProcessTree(child, {signal: 'SIGTERM', killAfterMs: 500});
        await waitFor(() => !isProcessAlive(grandchildPid));
    });
});
