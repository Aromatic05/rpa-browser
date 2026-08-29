import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {buildAgentRunReport} from '../../../../../src/agent/report/builder';
import {createSessionManager} from '../../../../../src/agent/service/session/manager';
import {createFileSystemSessionStorage} from '../../../../../src/agent/service/session/storage';
import type {StoredSessionMetadata} from '../../../../../src/agent/service/session/storage';
import type {AgentRunResult} from '../../../../../src/agent/execution/types';
import {deferred, flush, makeRequest, makeResult, makeResultWithSecret} from './helpers';

const tempDir = (): string => fs.mkdtempSync(path.join(process.cwd(), 'tmp-agent-manager-'));

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

test('running sessions are interrupted when the service restarts', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const pending = deferred<AgentRunResult>();
        const first = createSessionManager({runner: {run: () => pending.promise}, storage});
        const snapshot = first.start(makeRequest());
        const {sessionId} = snapshot;

        const second = createSessionManager({runner: {run: async () => makeResult()}, storage});
        const recovered = second.status(sessionId);
        assert.equal(recovered?.state, 'failed');
        assert.equal(recovered?.error?.code, 'ERR_SESSION_INTERRUPTED');
        assert.equal(recovered?.reportAvailable, false);

        // A third process observes the already-persisted interrupted state.
        const third = createSessionManager({runner: {run: async () => makeResult()}, storage});
        assert.equal(third.status(sessionId)?.state, 'failed');
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('terminal reports persist and survive service restart', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const result = makeResultWithSecret({text: 'terminal'});
        const manager = createSessionManager({runner: {run: async () => result}, storage});
        const {sessionId} = await manager.runTracked(makeRequest());

        assert.equal(manager.status(sessionId)?.state, 'completed');
        const firstReport = manager.report(sessionId)!;
        assert.equal(firstReport.report!.terminal.output, 'terminal');
        assert.deepEqual(firstReport.report!.toolCalls[0].args, {
            apiKey: '[redacted]',
            safe: 'visible',
        });

        const next = createSessionManager({runner: {run: async () => makeResult()}, storage});
        const recovered = next.status(sessionId);
        assert.equal(recovered?.state, 'completed');
        assert.equal(recovered?.reportAvailable, true);
        const secondReport = next.report(sessionId)!;
        assert.equal(secondReport.report!.terminal.output, 'terminal');
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('paused snapshots survive restart but are not resumable', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const paused = makeResult({
            programs: [{
                source: 'output ok = input.ok',
                input: {},
                status: 'paused',
                pause: {reason: 'barrier', continuationId: 'cont-1', stepName: 'effect.submit', risk: 'irreversible'},
            }],
            continuation: {resume: async () => makeResult({text: 'resumed'})},
        });
        const manager = createSessionManager({runner: {run: async () => paused}, storage});
        const {sessionId} = await manager.runTracked(makeRequest());

        assert.equal(manager.status(sessionId)?.state, 'paused');
        assert.equal(manager.status(sessionId)?.resumable, true);
        const interactions = manager.listInteractions(sessionId)!;
        assert.equal(interactions.length, 1);
        assert.equal(interactions[0].status, 'pending');

        const next = createSessionManager({runner: {run: async () => makeResult()}, storage});
        const recovered = next.status(sessionId)!;
        assert.equal(recovered.state, 'paused');
        assert.equal(recovered.resumable, false);
        assert.equal(recovered.reportAvailable, true);
        assert.deepEqual(recovered.interactions, []);
        assert.equal(await next.approveInteraction(sessionId, interactions[0].id, interactions[0].revision, 'ops-1'), null);
        assert.equal(next.report(sessionId)!.report!.terminal.status, 'paused');
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('prune removes sessions by age and count while preserving running sessions', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const now = Date.now();
        for (let index = 0; index < 3; index++) {
            storage.saveMetadata(baseMetadata({
                sessionId: `old-${index}`,
                state: 'completed',
                endedAt: now - 1000 * 60 * 60 * 24 * 7,
            }));
        }
        storage.saveMetadata(baseMetadata({sessionId: 'recent', state: 'completed', endedAt: now}));

        const pending = deferred<AgentRunResult>();
        const manager = createSessionManager({runner: {run: () => pending.promise}, storage});
        const running = manager.start(makeRequest({prompt: 'running'}));
        assert.equal(manager.list().length, 5);

        const prunedByAge = manager.prune({maxAgeMs: 1000 * 60 * 60 * 24});
        assert.equal(prunedByAge, 3);
        assert.equal(manager.status('recent')?.state, 'completed');
        assert.equal(manager.status(running.sessionId)?.state, 'running');

        for (let index = 0; index < 5; index++) {
            storage.saveMetadata(baseMetadata({
                sessionId: `count-${index}`,
                state: 'completed',
                endedAt: now - index,
            }));
        }
        const manager2 = createSessionManager({runner: {run: async () => makeResult()}, storage});
        // The running session from the previous process is loaded as interrupted.
        assert.equal(manager2.status(running.sessionId)?.state, 'failed');
        const prunedByCount = manager2.prune({maxCount: 3});
        assert.equal(prunedByCount >= 2, true);
        assert.equal(manager2.list().length <= 4, true);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('concurrent session writes produce stable ids and durable reports', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const manager = createSessionManager({runner: {run: async () => makeResultWithSecret()}, storage});
        const ids = await Promise.all(Array.from({length: 10}, async (_, index) => {
            const {sessionId} = await manager.runTracked(makeRequest({prompt: `c${index}`}));
            return sessionId;
        }));

        assert.equal(new Set(ids).size, ids.length);
        for (const id of ids) {
            const found = manager.report(id);
            assert.ok(found);
            assert.equal((found!.report!.toolCalls[0].args as {apiKey: string}).apiKey, '[redacted]');
        }

        const next = createSessionManager({runner: {run: async () => makeResult()}, storage});
        assert.equal(next.list().length, 10);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('failed sessions have no report and persist their error code', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const manager = createSessionManager({
            runner: {run: async () => {throw Object.assign(new Error('boom'), {code: 'ERR_BOOM'});}},
            storage,
        });

        await assert.rejects(() => manager.run(makeRequest()), /boom/);
        const [session] = manager.list();
        assert.equal(session.state, 'failed');
        assert.equal(session.error?.code, 'ERR_BOOM');
        assert.equal(session.reportAvailable, false);
        assert.equal(manager.report(session.sessionId), null);

        const next = createSessionManager({runner: {run: async () => makeResult()}, storage});
        assert.equal(next.status(session.sessionId)?.state, 'failed');
        assert.equal(next.report(session.sessionId), null);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('cancelled in-memory sessions remain cancelled after restart', async () => {
    const dataDir = tempDir();
    try {
        const storage = createFileSystemSessionStorage({dataDir});
        const pending = deferred<AgentRunResult>();
        const manager = createSessionManager({runner: {run: () => pending.promise}, storage});

        const runPromise = manager.run(makeRequest());
        const sessions = manager.list();
        assert.equal(sessions.length, 1);
        manager.cancel(sessions[0].sessionId);
        await assert.rejects(() => runPromise, /cancelled/);
        await flush();

        const next = createSessionManager({runner: {run: async () => makeResult()}, storage});
        const recovered = next.status(sessions[0].sessionId);
        assert.equal(recovered?.state, 'cancelled');
        assert.equal(recovered?.reportAvailable, false);
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});

test('report lookup matches buildAgentRunReport output for a completed run', async () => {
    const dataDir = tempDir();
    try {
        const result = makeResultWithSecret({text: 'match'});
        const storage = createFileSystemSessionStorage({dataDir});
        const manager = createSessionManager({runner: {run: async () => result}, storage});
        const {sessionId} = await manager.runTracked(makeRequest());

        const found = manager.report(sessionId)!;
        assert.deepEqual(found.report, buildAgentRunReport(result));
    } finally {
        fs.rmSync(dataDir, {recursive: true, force: true});
    }
});
