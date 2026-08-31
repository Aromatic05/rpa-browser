import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
    observeStaleDirectoryLock,
    observeStaleDirectoryLockSync,
    reclaimObservedDirectoryLock,
    reclaimObservedDirectoryLockSync,
} from '../../../src/platform/storage/directory_lock';

const deadPid = 2_147_483_647;

test('a delayed synchronous stale reclaimer cannot remove a newer lock owner', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rpa-directory-lock-sync-'));
    const lockDir = path.join(root, 'resource.lock');
    try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: deadPid,
            acquiredAt: Date.now() - 60_000,
            token: 'stale-owner',
        }));
        const firstObservation = observeStaleDirectoryLockSync(lockDir, 1);
        const delayedObservation = observeStaleDirectoryLockSync(lockDir, 1);
        assert.ok(firstObservation);
        assert.ok(delayedObservation);
        assert.equal(reclaimObservedDirectoryLockSync(lockDir, firstObservation), true);

        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            token: 'fresh-owner',
        }));

        assert.equal(reclaimObservedDirectoryLockSync(lockDir, delayedObservation), false);
        const owner = JSON.parse(fs.readFileSync(path.join(lockDir, 'owner.json'), 'utf8'));
        assert.equal(owner.token, 'fresh-owner');
    } finally {
        fs.rmSync(root, {recursive: true, force: true});
    }
});

test('a delayed ownerless stale reclaimer cannot remove a newer lock owner', async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'rpa-directory-lock-async-'));
    const lockDir = path.join(root, 'resource.lock');
    try {
        await fsp.mkdir(lockDir);
        const staleAt = new Date(Date.now() - 60_000);
        await fsp.utimes(lockDir, staleAt, staleAt);
        const firstObservation = await observeStaleDirectoryLock(lockDir, 1);
        assert.ok(firstObservation);
        const delayedObservation = structuredClone(firstObservation);
        assert.equal(await reclaimObservedDirectoryLock(lockDir, firstObservation), true);

        await fsp.mkdir(lockDir);
        await fsp.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify({
            pid: process.pid,
            acquiredAt: Date.now(),
            token: 'fresh-owner',
        }));

        assert.equal(await reclaimObservedDirectoryLock(lockDir, delayedObservation), false);
        const owner = JSON.parse(await fsp.readFile(path.join(lockDir, 'owner.json'), 'utf8'));
        assert.equal(owner.token, 'fresh-owner');
    } finally {
        await fsp.rm(root, {recursive: true, force: true});
    }
});
