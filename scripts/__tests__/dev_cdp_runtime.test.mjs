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
    const childSource = [
        "const {spawn} = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio: 'ignore'});",
        'console.log(child.pid);',
        'setInterval(() => {}, 1000);',
    ].join('\n');
    const child = spawnManagedProcess(process.execPath, ['-e', childSource], {
        stdio: ['ignore', 'pipe', 'inherit'],
    });
    const grandchildPid = await new Promise((resolve, reject) => {
        let output = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            output += chunk;
            const value = Number(output.trim());
            if (Number.isInteger(value) && value > 0) {resolve(value);}
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('managed process exited before reporting its child pid')));
    });

    assert.equal(isProcessAlive(child.pid), true);
    assert.equal(isProcessAlive(grandchildPid), true);
    await terminateProcessTree(child, {signal: 'SIGINT', killAfterMs: 500});
    await waitFor(() => !isProcessAlive(child.pid) && !isProcessAlive(grandchildPid));
});
