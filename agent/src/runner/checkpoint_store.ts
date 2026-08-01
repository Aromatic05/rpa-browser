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
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isRunStatus = (value: unknown): value is RunStatus =>
    typeof value === 'string' && RUN_STATUSES.has(value as RunStatus);

const toPayload = (checkpoints: Record<string, TaskRunCheckpoint>): PersistedTaskRunCheckpointsV1 => ({
    version: 1,
    savedAt: Date.now(),
    checkpoints,
});

const invalidStore = (filePath: string, error?: unknown): Error => new Error(
    `invalid task checkpoint store: ${filePath}`,
    error instanceof Error ? {cause: error} : undefined,
);

const readPayload = async (filePath: string): Promise<PersistedTaskRunCheckpointsV1 | null> => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed: unknown = JSON.parse(raw);
        if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.checkpoints)) {
            throw invalidStore(filePath);
        }
        return {
            version: 1,
            savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
            checkpoints: parsed.checkpoints,
        };
    } catch (error) {
        if (isMissingFile(error)) {return null;}
        if (error instanceof Error && error.message.startsWith('invalid task checkpoint store:')) {
            throw error;
        }
        throw invalidStore(filePath, error);
    }
};

const isMissingFile = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const persistPayloadToFile = async (filePath: string, payload: string): Promise<void> => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
        await fs.writeFile(tmpPath, payload, 'utf8');
        await fs.rename(tmpPath, filePath);
    } catch (error) {
        await fs.rm(tmpPath, {force: true});
        throw error;
    }
};

export const createTaskCheckpointStore = (
    filePath: string,
    opts?: {
        flushIntervalMs?: number;
        persistPayload?: (filePath: string, payload: string) => Promise<void>;
    },
): TaskCheckpointStore => {
    const checkpoints = new Map<string, TaskRunCheckpoint>();
    const intervalMs = opts?.flushIntervalMs && opts.flushIntervalMs > 0 ? Math.floor(opts.flushIntervalMs) : 1200;
    const persistPayload = opts?.persistPayload ?? persistPayloadToFile;
    let activeFlush: Promise<void> | null = null;
    let lastSnapshot = '';

    const load = async (): Promise<Map<string, TaskRunCheckpoint>> => {
        const payload = await readPayload(filePath);
        const loaded = new Map<string, TaskRunCheckpoint>();
        if (!payload) {
            checkpoints.clear();
            lastSnapshot = snapshotState(loaded);
            return checkpoints;
        }
        for (const [runId, rawCheckpoint] of Object.entries(payload.checkpoints)) {
            if (!runId || !isRecord(rawCheckpoint)
                || rawCheckpoint.runId !== runId
                || typeof rawCheckpoint.workspaceName !== 'string' || !rawCheckpoint.workspaceName
                || !isNonNegativeSafeInteger(rawCheckpoint.cursor)
                || !isRunStatus(rawCheckpoint.status)) {
                throw invalidStore(filePath);
            }
            loaded.set(runId, {
                runId,
                workspaceName: rawCheckpoint.workspaceName,
                status: rawCheckpoint.status,
                cursor: rawCheckpoint.cursor,
                nextSeq: isNonNegativeSafeInteger(rawCheckpoint.nextSeq) ? rawCheckpoint.nextSeq : rawCheckpoint.cursor,
                lastAckSeq: isAckSequence(rawCheckpoint.lastAckSeq)
                    ? rawCheckpoint.lastAckSeq
                    : Math.max(-1, rawCheckpoint.cursor - 1),
                updatedAt: isFiniteNumber(rawCheckpoint.updatedAt) ? rawCheckpoint.updatedAt : Date.now(),
            });
        }
        checkpoints.clear();
        for (const [runId, checkpoint] of loaded) {checkpoints.set(runId, checkpoint);}
        lastSnapshot = snapshotState(loaded);
        return checkpoints;
    };

    const flush = async (): Promise<void> => {
        while (true) {
            if (activeFlush) {
                await activeFlush;
                continue;
            }
            const checkpointSnapshot = Object.fromEntries(
                [...checkpoints.entries()].map(([runId, checkpoint]) => [runId, structuredClone(checkpoint)]),
            );
            const snapshot = JSON.stringify(checkpointSnapshot);
            if (snapshot === lastSnapshot) {return;}
            const payload = JSON.stringify(toPayload(checkpointSnapshot), null, 2);
            const currentFlush = persistPayload(filePath, payload);
            activeFlush = currentFlush;
            try {
                await currentFlush;
                lastSnapshot = snapshot;
            } finally {
                if (activeFlush === currentFlush) {activeFlush = null;}
            }
        }
    };

    const timer = setInterval(() => {
        void flush().catch(() => undefined);
    }, intervalMs);
    timer.unref();

    return {
        checkpoints,
        load,
        flush,
        stop: () => { clearInterval(timer); },
    };
};

const snapshotState = (checkpoints: Map<string, TaskRunCheckpoint>): string =>
    JSON.stringify(Object.fromEntries(checkpoints.entries()));

const isNonNegativeSafeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isAckSequence = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= -1;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
