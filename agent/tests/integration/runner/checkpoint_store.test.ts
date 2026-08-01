import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
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

test('independent checkpoint stores merge runs instead of overwriting the shared file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-shared-'));
    const filePath = path.join(root, 'checkpoints.json');
    const first = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
    const second = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
    try {
        await first.load();
        await second.load();

        first.checkpoints.set('run-1', checkpoint('running', 0));
        await first.flush();

        second.checkpoints.set('run-2', {
            ...checkpoint('completed', 1),
            runId: 'run-2',
            workspaceName: 'ws-2',
        });
        await second.flush();

        const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
            checkpoints: Record<string, {workspaceName: string}>;
        };
        assert.deepEqual(Object.keys(persisted.checkpoints).sort(), ['run-1', 'run-2']);
        assert.equal(persisted.checkpoints['run-1'].workspaceName, 'ws-1');
        assert.equal(persisted.checkpoints['run-2'].workspaceName, 'ws-2');
    } finally {
        first.stop();
        second.stop();
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('checkpoint stores in separate processes merge concurrent flushes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-processes-'));
    const filePath = path.join(root, 'checkpoints.json');
    const goFile = path.join(root, 'go');
    const moduleUrl = pathToFileURL(path.resolve('src/runner/checkpoint_store.ts')).href;
    const fileExists = async (file: string): Promise<boolean> => await fs.stat(file).then(() => true, () => false);
    const runChild = (runId: string, workspaceName: string, readyFile: string) =>
        new Promise<{code: number | null; stderr: string}>((resolve) => {
            const script = `
                import fs from 'node:fs';
                import timers from 'node:timers/promises';
                const module = await import(${JSON.stringify(moduleUrl)});
                const store = module.createTaskCheckpointStore(${JSON.stringify(filePath)}, {flushIntervalMs: 60000});
                await store.load();
                store.checkpoints.set(${JSON.stringify(runId)}, {
                    runId: ${JSON.stringify(runId)},
                    workspaceName: ${JSON.stringify(workspaceName)},
                    status: 'running',
                    cursor: 0,
                    nextSeq: 0,
                    lastAckSeq: -1,
                    updatedAt: Date.now(),
                });
                fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');
                while (!fs.existsSync(${JSON.stringify(goFile)})) { await timers.setTimeout(5); }
                await store.flush();
                store.stop();
            `;
            const child = spawn('node', ['--import', 'tsx', '--input-type=module', '--eval', script], {
                cwd: path.resolve('.'),
                env: process.env,
                stdio: ['ignore', 'ignore', 'pipe'],
            });
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {stderr += chunk;});
            child.on('close', (code) => resolve({code, stderr}));
        });
    const readyFiles = [path.join(root, 'ready-1'), path.join(root, 'ready-2')];
    try {
        const first = runChild('process-run-1', 'ws-1', readyFiles[0]);
        const second = runChild('process-run-2', 'ws-2', readyFiles[1]);
        for (let attempt = 0; attempt < 400; attempt += 1) {
            if ((await Promise.all(readyFiles.map(fileExists))).every(Boolean)) {break;}
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
        assert.equal((await Promise.all(readyFiles.map(fileExists))).every(Boolean), true);
        await fs.writeFile(goFile, 'go');
        const results = await Promise.all([first, second]);
        assert.deepEqual(results.map((result) => result.code), [0, 0], results.map((result) => result.stderr).join('\n'));

        const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
            checkpoints: Record<string, {workspaceName: string}>;
        };
        assert.deepEqual(Object.keys(persisted.checkpoints).sort(), ['process-run-1', 'process-run-2']);
    } finally {
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('persisted terminal runs cannot be revived by a newer non-terminal snapshot', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-terminal-'));
    const filePath = path.join(root, 'checkpoints.json');
    const terminal = {
        ...checkpoint('completed', 1),
        updatedAt: Date.now(),
    };
    await fs.writeFile(filePath, JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        checkpoints: {'run-1': terminal},
    }), 'utf8');
    const store = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
    try {
        await store.load();
        store.checkpoints.set('run-1', {
            ...terminal,
            status: 'running',
            updatedAt: terminal.updatedAt + 1000,
        });
        await store.flush();

        const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
            checkpoints: Record<string, {status: string}>;
        };
        assert.equal(persisted.checkpoints['run-1'].status, 'completed');
    } finally {
        store.stop();
        await fs.rm(root, {recursive: true, force: true});
    }
});

test('checkpoint store validates local state before replacing a valid file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-checkpoint-write-validation-'));
    const filePath = path.join(root, 'checkpoints.json');
    const store = createTaskCheckpointStore(filePath, {flushIntervalMs: 60_000});
    try {
        await store.load();
        store.checkpoints.set('run-1', checkpoint('running', 0));
        await store.flush();

        store.checkpoints.set('run-1', {
            ...checkpoint('running', 0),
            cursor: -1,
        });
        await assert.rejects(() => store.flush(), /invalid task checkpoint store/i);

        const persisted = JSON.parse(await fs.readFile(filePath, 'utf8')) as {
            checkpoints: Record<string, {cursor: number}>;
        };
        assert.equal(persisted.checkpoints['run-1'].cursor, 0);
    } finally {
        store.stop();
        await fs.rm(root, {recursive: true, force: true});
    }
});
