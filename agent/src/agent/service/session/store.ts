import crypto from 'node:crypto';
import type {AgentRunRequest} from '../../execution/types';
import type {SessionId, SessionRequestSummary, SessionSnapshot, SessionState} from './types';

type SessionRecord = {
    sessionId: SessionId;
    state: SessionState;
    createdAt: number;
    startedAt: number;
    endedAt: number | null;
    request: SessionRequestSummary;
    result: SessionSnapshot['result'];
    error: SessionSnapshot['error'];
};

export type SessionSettle = {
    state: Exclude<SessionState, 'running'>;
    result?: SessionSnapshot['result'];
    error?: SessionSnapshot['error'];
};

const SETTLED: ReadonlySet<SessionState> = new Set(['paused', 'completed', 'failed', 'cancelled']);

const newSessionId = (): SessionId => crypto.randomUUID();

const summarizeRequest = (request: AgentRunRequest): SessionRequestSummary => ({
    prompt: request.prompt,
    provider: request.provider,
    model: request.model,
    ...(request.executionMode === undefined ? {} : {executionMode: request.executionMode}),
    ...(request.source === undefined ? {} : {source: request.source}),
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
});

export type SessionStore = {
    create: (request: AgentRunRequest) => SessionSnapshot;
    settle: (sessionId: SessionId, patch: SessionSettle) => SessionSnapshot | null;
    get: (sessionId: SessionId) => SessionSnapshot | null;
    list: () => SessionSnapshot[];
    clear: () => void;
};

export const createSessionStore = (): SessionStore => {
    const records = new Map<SessionId, SessionRecord>();
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
            };
            records.set(record.sessionId, record);
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
            return toSnapshot(record);
        },
        get: (sessionId) => {
            const record = records.get(sessionId);
            return record ? toSnapshot(record) : null;
        },
        list: () => Array.from(records.values(), toSnapshot),
        clear: () => {records.clear();},
    };
};
