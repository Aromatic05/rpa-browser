import crypto from 'node:crypto';
import type {AgentRunRequest, AgentRunResult} from '../../execution/types';
import type {AgentRunReport} from '../../report/contracts';
import type {SessionId, SessionRequestSummary, SessionSnapshot, SessionState} from './types';
import type {SessionStorage, StoredSessionMetadata} from './storage';

type SessionRecord = {
    sessionId: SessionId;
    state: SessionState;
    createdAt: number;
    startedAt: number;
    endedAt: number | null;
    request: SessionRequestSummary;
    result: AgentRunResult | null;
    error: SessionSnapshot['error'];
    report: AgentRunReport | null;
    reportAvailable: boolean;
};

export type SessionSettle = {
    state: Exclude<SessionState, 'running'>;
    result?: SessionSnapshot['result'];
    error?: SessionSnapshot['error'];
    report?: AgentRunReport;
};

const SETTLED: ReadonlySet<SessionState> = new Set(['paused', 'completed', 'failed', 'cancelled', 'interrupted']);

const INTERRUPTED_ERROR: SessionSnapshot['error'] = Object.freeze({
    code: 'ERR_SESSION_INTERRUPTED',
    message: 'session was interrupted by service restart',
});

const newSessionId = (): SessionId => crypto.randomUUID();

const summarizeRequest = (request: AgentRunRequest): SessionRequestSummary => ({
    prompt: request.prompt,
    provider: request.provider,
    model: request.model,
    ...(request.executionMode === undefined ? {} : {executionMode: request.executionMode}),
    ...(request.source === undefined ? {} : {source: request.source}),
});

const toPersisted = (record: SessionRecord): StoredSessionMetadata => ({
    sessionId: record.sessionId,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    request: record.request,
    error: record.error,
    reportAvailable: record.reportAvailable,
});

const fromPersisted = (metadata: StoredSessionMetadata): SessionRecord => ({
    sessionId: metadata.sessionId,
    state: metadata.state,
    createdAt: metadata.createdAt,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt,
    request: metadata.request,
    result: null,
    error: metadata.error,
    report: null,
    reportAvailable: metadata.reportAvailable,
});

const toSnapshot = (record: SessionRecord): SessionSnapshot => Object.freeze({
    sessionId: record.sessionId,
    state: record.state,
    createdAt: record.createdAt,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    request: Object.freeze({...record.request}),
    result: record.result,
    error: record.error,
    reportAvailable: record.reportAvailable,
    resumable: record.state === 'paused'
        && record.result?.continuation !== undefined,
    interactions: [],
});

export type SessionStoreOptions = {
    storage?: SessionStorage;
};

export type SessionRetentionPolicy = {
    maxAgeMs?: number;
    maxCount?: number;
};

export type SessionStore = {
    create: (request: AgentRunRequest) => SessionSnapshot;
    settle: (sessionId: SessionId, patch: SessionSettle) => SessionSnapshot | null;
    reopen: (sessionId: SessionId) => SessionSnapshot | null;
    terminate: (sessionId: SessionId, patch: SessionSettle) => SessionSnapshot | null;
    discard: (sessionId: SessionId) => boolean;
    get: (sessionId: SessionId) => SessionSnapshot | null;
    getReport: (sessionId: SessionId) => AgentRunReport | null;
    list: () => SessionSnapshot[];
    prune: (policy: SessionRetentionPolicy) => number;
    clear: () => void;
};

export const createSessionStore = (options: SessionStoreOptions = {}): SessionStore => {
    const storage = options.storage;
    const records = new Map<SessionId, SessionRecord>();

    if (storage) {
        const now = Date.now();
        for (const metadata of storage.load()) {
            const record: SessionRecord = metadata.state === 'running'
                ? {
                    ...fromPersisted(metadata),
                    state: 'interrupted',
                    error: INTERRUPTED_ERROR,
                    endedAt: now,
                    reportAvailable: false,
                }
                : fromPersisted(metadata);
            records.set(record.sessionId, record);
            if (metadata.state === 'running') {
                storage.saveMetadata(toPersisted(record));
            }
        }
    }

    const persist = (record: SessionRecord): void => {
        if (!storage) {return;}
        storage.saveMetadata(toPersisted(record));
        if (record.report) {
            storage.saveReport(record.sessionId, record.report);
        }
    };

    return {
        create: (request) => {
            const now = Date.now();
            const record: SessionRecord = {
                sessionId: newSessionId(),
                state: 'running',
                createdAt: now,
                startedAt: now,
                endedAt: null,
                request: summarizeRequest(request),
                result: null,
                error: null,
                report: null,
                reportAvailable: false,
            };
            records.set(record.sessionId, record);
            persist(record);
            return toSnapshot(record);
        },
        settle: (sessionId, patch) => {
            const record = records.get(sessionId);
            if (!record) {return null;}
            if (SETTLED.has(record.state)) {return toSnapshot(record);}
            record.state = patch.state;
            record.result = patch.result ?? null;
            record.error = patch.error ?? null;
            record.endedAt = Date.now();
            if (patch.report) {
                record.report = patch.report;
                record.reportAvailable = true;
            }
            persist(record);
            return toSnapshot(record);
        },
        reopen: (sessionId) => {
            const record = records.get(sessionId);
            if (record?.state !== 'paused') {return null;}
            record.state = 'running';
            record.endedAt = null;
            persist(record);
            return toSnapshot(record);
        },
        terminate: (sessionId, patch) => {
            const record = records.get(sessionId);
            if (!record) {return null;}
            if (record.state !== 'paused') {return toSnapshot(record);}
            record.state = patch.state;
            if (patch.result !== undefined) {record.result = patch.result;}
            if (patch.error !== undefined) {record.error = patch.error;}
            record.endedAt = Date.now();
            if (patch.report) {
                record.report = patch.report;
                record.reportAvailable = true;
            }
            persist(record);
            return toSnapshot(record);
        },
        discard: (sessionId) => {
            const record = records.get(sessionId);
            if (!record) {return false;}
            records.delete(sessionId);
            storage?.delete(sessionId);
            return true;
        },
        get: (sessionId) => {
            const record = records.get(sessionId);
            return record ? toSnapshot(record) : null;
        },
        getReport: (sessionId) => {
            const record = records.get(sessionId);
            if (!record?.reportAvailable) {return null;}
            if (record.report) {return record.report;}
            if (storage) {
                const loaded = storage.loadReport(sessionId);
                record.report = loaded;
                return loaded;
            }
            return null;
        },
        list: () => Array.from(records.values(), toSnapshot),
        prune: (policy) => {
            const now = Date.now();
            let removed = 0;
            if (policy.maxAgeMs !== undefined) {
                for (const [id, record] of records) {
                    if (record.state === 'running') {continue;}
                    if (record.endedAt !== null && now - record.endedAt > policy.maxAgeMs) {
                        records.delete(id);
                        storage?.delete(id);
                        removed++;
                    }
                }
            }
            if (policy.maxCount !== undefined && records.size > policy.maxCount) {
                const terminal = Array.from(records.values())
                    .filter((record) => record.state !== 'running')
                    .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
                const keep = new Set(terminal.slice(0, policy.maxCount).map((record) => record.sessionId));
                for (const [id, record] of records) {
                    if (record.state === 'running' || keep.has(id)) {continue;}
                    records.delete(id);
                    storage?.delete(id);
                    removed++;
                }
            }
            return removed;
        },
        clear: () => {
            if (storage) {
                for (const id of records.keys()) {
                    storage.delete(id);
                }
            }
            records.clear();
        },
    };
};
