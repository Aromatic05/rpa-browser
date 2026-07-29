import fs from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint, RunStatus } from './run_steps_types';

export type TaskRunCheckpoint = Checkpoint & {
    workspaceName: string;
    nextSeq: number;
    lastAckSeq: number;
};

type PersistedTaskRunCheckpointsV1 = {
    version: 1;
    savedAt: number;
    checkpoints: Record<string, unknown>;
};

export type TaskCheckpointStore = {
    checkpoints: Map<string, TaskRunCheckpoint>;
    load: () => Promise<Map<string, TaskRunCheckpoint>>;
    flush: () => Promise<void>;
    stop: () => void;
};

const RUN_STATUSES = new Set<RunStatus>(['running', 'suspended', 'completed', 'failed', 'halted']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

const isRunStatus = (value: unknown): value is RunStatus =>
    typeof value === 'string' && RUN_STATUSES.has(value as RunStatus);

const toPayload = (checkpoints: Map<string, TaskRunCheckpoint>): PersistedTaskRunCheckpointsV1 => ({
    version: 1,
    savedAt: Date.now(),
    checkpoints: Object.fromEntries(checkpoints.entries()),
});

const readPayload = async (filePath: string): Promise<PersistedTaskRunCheckpointsV1 | null> => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.checkpoints)) {
            return null;
        }
        return {
            version: 1,
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
            checkpoints: parsed.checkpoints,
        };
    } catch {
        return null;
    }
};

const persist = async (filePath: string, checkpoints: Map<string, TaskRunCheckpoint>): Promise<void> => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const payload = JSON.stringify(toPayload(checkpoints), null, 2);
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, filePath);
};

export const createTaskCheckpointStore = (
    filePath: string,
    opts?: { flushIntervalMs?: number },
): TaskCheckpointStore => {
    const checkpoints = new Map<string, TaskRunCheckpoint>();
    const intervalMs = opts?.flushIntervalMs && opts.flushIntervalMs > 0 ? Math.floor(opts.flushIntervalMs) : 1200;
    let writing = false;
    let lastSnapshot = '';

    const load = async (): Promise<Map<string, TaskRunCheckpoint>> => {
        const payload = await readPayload(filePath);
        checkpoints.clear();
        if (!payload) {return checkpoints;}
        for (const [runId, rawCheckpoint] of Object.entries(payload.checkpoints)) {
            if (!runId || !isRecord(rawCheckpoint)) {continue;}
            if (typeof rawCheckpoint.workspaceName !== 'string' || !rawCheckpoint.workspaceName) {continue;}
            if (typeof rawCheckpoint.cursor !== 'number' || !isRunStatus(rawCheckpoint.status)) {continue;}
            checkpoints.set(runId, {
                runId,
                workspaceName: rawCheckpoint.workspaceName,
                status: rawCheckpoint.status,
                cursor: rawCheckpoint.cursor,
                nextSeq: typeof rawCheckpoint.nextSeq === 'number' ? rawCheckpoint.nextSeq : rawCheckpoint.cursor,
                lastAckSeq: typeof rawCheckpoint.lastAckSeq === 'number'
                    ? rawCheckpoint.lastAckSeq
                    : Math.max(-1, rawCheckpoint.cursor - 1),
                updatedAt: typeof rawCheckpoint.updatedAt === 'number' ? rawCheckpoint.updatedAt : Date.now(),
            });
        }
        return checkpoints;
    };

    const flush = async (): Promise<void> => {
        if (writing) {return;}
        const snapshot = JSON.stringify(toPayload(checkpoints));
        if (snapshot === lastSnapshot) {return;}
        writing = true;
        try {
            await persist(filePath, checkpoints);
            lastSnapshot = snapshot;
        } finally {
            writing = false;
        }
    };

    const timer = setInterval(() => {
        void flush();
    }, intervalMs);
    timer.unref();

    return {
        checkpoints,
        load,
        flush,
        stop: () => { clearInterval(timer); },
    };
};
