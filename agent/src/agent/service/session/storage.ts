import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {serializeAgentRunReport, parseAgentRunReport} from '../../report/serialization';
import type {AgentRunReport} from '../../report/contracts';
import type {SessionError, SessionId, SessionRequestSummary, SessionState} from './types';

export type StoredSessionMetadata = Readonly<{
    sessionId: SessionId;
    state: SessionState;
    createdAt: number;
    startedAt: number;
    endedAt: number | null;
    request: SessionRequestSummary;
    error: SessionError | null;
    reportAvailable: boolean;
}>;

export type SessionStorage = {
    load: () => StoredSessionMetadata[];
    saveMetadata: (metadata: StoredSessionMetadata) => void;
    loadReport: (sessionId: SessionId) => AgentRunReport | null;
    saveReport: (sessionId: SessionId, report: AgentRunReport) => void;
    delete: (sessionId: SessionId) => void;
};

const METADATA_DIR = 'metadata';
const REPORTS_DIR = 'reports';

const atomicWriteJsonSync = (filePath: string, value: unknown): void => {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, {recursive: true});
    const tmp = path.join(dir, `.tmp-${crypto.randomUUID()}.json`);
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
    fs.renameSync(tmp, filePath);
};

const safeReadJsonSync = (filePath: string): unknown => {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    } catch {
        return null;
    }
};

const isStoredMetadata = (value: unknown): value is StoredSessionMetadata => {
    if (value === null || typeof value !== 'object') {return false;}
    const record = value as Record<string, unknown>;
    return typeof record.sessionId === 'string'
        && typeof record.state === 'string'
        && typeof record.createdAt === 'number'
        && typeof record.startedAt === 'number'
        && (record.endedAt === null || typeof record.endedAt === 'number')
        && record.request !== null && typeof record.request === 'object'
        && (record.error === null || typeof record.error === 'object')
        && typeof record.reportAvailable === 'boolean';
};

export type CreateFileSystemSessionStorageOptions = {
    dataDir: string;
    log?: (...args: unknown[]) => void;
};

export const createFileSystemSessionStorage = (
    options: CreateFileSystemSessionStorageOptions,
): SessionStorage => {
    const dataDir = path.resolve(options.dataDir);
    const metadataDir = path.join(dataDir, METADATA_DIR);
    const reportsDir = path.join(dataDir, REPORTS_DIR);

    fs.mkdirSync(metadataDir, {recursive: true});
    fs.mkdirSync(reportsDir, {recursive: true});

    const metadataPath = (sessionId: SessionId): string =>
        path.join(metadataDir, `${sessionId}.json`);

    const reportPath = (sessionId: SessionId): string =>
        path.join(reportsDir, `${sessionId}.json`);

    return {
        load: () => {
            const entries: StoredSessionMetadata[] = [];
            let files: string[];
            try {
                files = fs.readdirSync(metadataDir);
            } catch (error) {
                options.log?.('agent session storage cannot read metadata dir', error);
                return entries;
            }
            for (const file of files) {
                if (!file.endsWith('.json')) {continue;}
                const filePath = path.join(metadataDir, file);
                const raw = safeReadJsonSync(filePath);
                if (!isStoredMetadata(raw)) {
                    options.log?.('agent session storage skipping corrupt metadata', filePath);
                    continue;
                }
                entries.push(raw);
            }
            return entries;
        },
        saveMetadata: (metadata) => {
            atomicWriteJsonSync(metadataPath(metadata.sessionId), metadata);
        },
        loadReport: (sessionId) => {
            const filePath = reportPath(sessionId);
            const raw = safeReadJsonSync(filePath);
            if (raw === null) {return null;}
            try {
                return parseAgentRunReport(JSON.stringify(raw));
            } catch (error) {
                options.log?.('agent session storage skipping corrupt report', filePath, error);
                return null;
            }
        },
        saveReport: (sessionId, report) => {
            atomicWriteJsonSync(reportPath(sessionId), JSON.parse(serializeAgentRunReport(report)));
        },
        delete: (sessionId) => {
            try {
                fs.unlinkSync(metadataPath(sessionId));
            } catch {
                // ignore missing files
            }
            try {
                fs.unlinkSync(reportPath(sessionId));
            } catch {
                // ignore missing files
            }
        },
    };
};

export const createInMemorySessionStorage = (): SessionStorage => {
    const metadata = new Map<SessionId, StoredSessionMetadata>();
    const reports = new Map<SessionId, AgentRunReport>();

    return {
        load: () => Array.from(metadata.values()),
        saveMetadata: (record) => {metadata.set(record.sessionId, record);},
        loadReport: (sessionId) => reports.get(sessionId) ?? null,
        saveReport: (sessionId, report) => {reports.set(sessionId, report);},
        delete: (sessionId) => {
            metadata.delete(sessionId);
            reports.delete(sessionId);
        },
    };
};
