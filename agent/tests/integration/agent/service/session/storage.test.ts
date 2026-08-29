import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {buildAgentRunReport} from '../../../../../src/agent/report/builder';
import {
    createFileSystemSessionStorage,
    createInMemorySessionStorage,
} from '../../../../../src/agent/service/session/storage';
import type {StoredSessionMetadata} from '../../../../../src/agent/service/session/storage';
import {makeResult, makeResultWithSecret} from './helpers';

const baseMetadata = (overrides: Partial<StoredSessionMetadata> = {}): StoredSessionMetadata => ({
    sessionId: crypto.randomUUID(),
    state: 'completed',
    createdAt: Date.now(),
    startedAt: Date.now(),
    endedAt: Date.now(),
    request: {prompt: 'test', provider: 'p', model: 'm'},
    error: null,
    reportAvailable: false,
    ...overrides,
});

const tempDir = (): string => fs.mkdtempSync(path.join(process.cwd(), 'tmp-agent-storage-'));

test('in-memory storage round-trips metadata and reports', () => {
    const storage = createInMemorySessionStorage();
    const meta = baseMetadata({sessionId: 's1'});
    storage.saveMetadata(meta);

    const loaded = storage.load();
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].sessionId, 's1');

    const report = buildAgentRunReport(makeResult({text: 'hello'}));
    storage.saveReport('s1', report);
    assert.deepEqual(storage.loadReport('s1'), report);

    storage.delete('s1');
    assert.equal(storage.load().length, 0);
    assert.equal(storage.loadReport('s1'), null);
});

test('file system storage persists metadata across instances', () => {
    const dataDir = tempDir();
    try {
        const first = createFileSystemSessionStorage({dataDir});
        const meta = baseMetadata({sessionId: 's1', state: 'paused'});
        first.saveMetadata(meta);

        const second = createFileSystemSessionStorage({dataDir});
        const loaded = second.load();
        assert.equal(loaded.length, 1);
        assert.equal(loaded[0].sessionId, 's1');
        assert.equal(loaded[0].state, 'paused');
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('file system storage persists redacted reports, not raw tool args', () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const report = buildAgentRunReport(makeResultWithSecret({text: 'ok'}));
        storage.saveReport('s1', report);

        const reportPath = path.join(dataDir, 'reports', 's1.json');
        const raw = fs.readFileSync(reportPath, 'utf8');
        assert.ok(!raw.includes('raw-secret-value'));
        assert.ok(raw.includes('[redacted]'));
        assert.ok(raw.includes('rpa.agent.run-report'));

        const loaded = storage.loadReport('s1');
        assert.deepEqual(loaded, report);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('file system storage recovers from corrupt metadata files', () => {
    const dataDir = tempDir();
    try {
        fs.mkdirSync(path.join(dataDir, 'metadata'), {recursive: true});
        fs.writeFileSync(path.join(dataDir, 'metadata', 'good.json'), JSON.stringify(baseMetadata({sessionId: 'good'})), 'utf8');
        fs.writeFileSync(path.join(dataDir, 'metadata', 'bad.json'), 'not json', 'utf8');
        fs.writeFileSync(path.join(dataDir, 'metadata', 'incomplete.json'), JSON.stringify({sessionId: 'incomplete'}), 'utf8');

        const logs: unknown[] = [];
        const storage = createFileSystemSessionStorage({dataDir, log: (...args) => logs.push(args)});
        const loaded = storage.load();
        const ids = loaded.map((meta) => meta.sessionId).sort();
        assert.deepEqual(ids, ['good']);
        assert.ok(logs.some((entry) => Array.isArray(entry) && entry.some((item) => typeof item === 'string' && item.includes('corrupt metadata'))));
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('file system storage fail-closes on corrupt report files', () => {
    const dataDir = tempDir();
    try {
        fs.mkdirSync(path.join(dataDir, 'reports'), {recursive: true});
        fs.writeFileSync(path.join(dataDir, 'reports', 'bad.json'), JSON.stringify({notAReport: true}), 'utf8');

        const logs: unknown[] = [];
        const storage = createFileSystemSessionStorage({dataDir, log: (...args) => logs.push(args)});
        assert.equal(storage.loadReport('bad'), null);
        assert.ok(logs.some((entry) => Array.isArray(entry) && entry.some((item) => typeof item === 'string' && item.includes('corrupt report'))));
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('file system storage atomic writes survive concurrent session creation', () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const ids = Array.from({length: 20}, (_, index) => `concurrent-${index}`);
        for (const id of ids) {
            storage.saveMetadata(baseMetadata({sessionId: id}));
        }
        const loaded = storage.load();
        assert.equal(loaded.length, ids.length);
        assert.deepEqual(loaded.map((meta) => meta.sessionId).sort(), ids.sort());
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});
