import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTaskCheckpointStore} from '../../../src/runner/checkpoint_store';

const checkpoint = (status: 'running' | 'completed', cursor: number) => ({
    runId: 'run-1',
    workspaceName: 'ws-1',
    status,
    cursor,
    nextSeq: cursor,
    lastAckSeq: Math.max(-1, cursor - 1),
    updatedAt: Date.now(),
});

test('checkpoint store rejects corrupt persistence instead of silently erasing resume state', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-corrupt-'));
    const filePath = path.join(root, 'checkpoints.json');
    try {
        await fs.writeFile(filePath, '{not-json', 'utf8');
        const store = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
        try {
            await assert.rejects(() => store.load(), /invalid task checkpoint store/i);
        } finally {
            store.stop();
        }
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('checkpoint store load is atomic and rejects entry identity mismatches', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-atomic-load-'));
    const filePath = path.join(root, 'checkpoints.json');
    const store = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
    try {
        store.checkpoints.set('existing', {
            ...checkpoint('running', 0),
            runId: 'existing',
        });
        await fs.writeFile(filePath, JSON.stringify({
            version: 1,
            savedAt: Date.now(),
            checkpoints: {
                'run-1': checkpoint('running', 0),
                'run-2': {...checkpoint('completed', 1), runId: 'different-id'},
            },
        }), 'utf8');

        await assert.rejects(() => store.load(), /invalid task checkpoint store/i);
        assert.deepEqual([...store.checkpoints.keys()], ['existing']);
        assert.equal(store.checkpoints.get('existing')?.status, 'running');
    } finally {
        store.stop();
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('concurrent checkpoint flushes wait until the latest state is durable', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {releaseFirst = resolve;});
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {firstStarted = resolve;});
    const payloads: string[] = [];
    let writes = 0;
    const store = createTaskCheckpointStore('/unused/checkpoints.json', {
        flushIntervalMs: 60_000,
        persistPayload: async (_filePath, payload) => {
            writes += 1;
            payloads.push(payload);
            if (writes === 1) {
                firstStarted();
                await firstGate;
            }
        },
    });
    try {
        store.checkpoints.set('run-1', checkpoint('running', 0));
        const firstFlush = store.flush();
        await firstStartedPromise;

        store.checkpoints.set('run-1', checkpoint('completed', 1));
        let secondResolved = false;
        const secondFlush = store.flush().then(() => {secondResolved = true;});
        await new Promise((resolve) => setTimeout(resolve, 5));
        assert.equal(secondResolved, false, 'second flush must wait for the latest state to persist');

        releaseFirst();
        await Promise.all([firstFlush, secondFlush]);
        assert.equal(writes, 2);
        const persisted = JSON.parse(payloads.at(-1)!) as {checkpoints: Record<string, {status: string; cursor: number}>};
        assert.equal(persisted.checkpoints['run-1'].status, 'completed');
        assert.equal(persisted.checkpoints['run-1'].cursor, 1);
    } finally {
        store.stop();
    }
});
