import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Checkpoint, RunStatus} from './run_steps_types';
import {
    observeStaleDirectoryLock,
    readDirectoryLockOwner,
    reclaimObservedDirectoryLock,
} from '../storage/directory_lock';

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

type TaskCheckpointStoreOptions = {
    flushIntervalMs?: number;
    persistPayload?: (filePath: string, payload: string) => Promise<void>;
};

type CheckpointFileLockOwner = {
    pid: number;
    acquiredAt: number;
    token: string;
};

type SharedStoreEntry = {
    store: TaskCheckpointStore;
    references: number;
};

const RUN_STATUSES = new Set<RunStatus>(['running', 'suspended', 'completed', 'failed', 'halted']);
const CHECKPOINT_LOCK_WAIT_MS = 10_000;
const CHECKPOINT_LOCK_RETRY_MS = 10;
const CHECKPOINT_LOCK_STALE_MS = 5 * 60_000;
const sharedStores = new Map<string, SharedStoreEntry>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isRunStatus = (value: unknown): value is RunStatus =>
    typeof value === 'string' && RUN_STATUSES.has(value as RunStatus);

const isMissingFile = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';

const isExistingPath = (error: unknown): boolean =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';

const isNonNegativeSafeInteger = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const isAckSequence = (value: unknown): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= -1;

const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);

const invalidStore = (filePath: string, error?: unknown): Error => new Error(
    `invalid task checkpoint store: ${filePath}`,
    error instanceof Error ? {cause: error} : undefined,
);

const toCheckpointRecord = (
    checkpoints: Map<string, TaskRunCheckpoint>,
): Record<string, TaskRunCheckpoint> => Object.fromEntries(
    [...checkpoints.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([runId, checkpoint]) => [runId, structuredClone(checkpoint)]),
);

const toPayload = (checkpoints: Map<string, TaskRunCheckpoint>): PersistedTaskRunCheckpointsV1 => ({
    version: 1,
    savedAt: Date.now(),
    checkpoints: toCheckpointRecord(checkpoints),
});

const snapshotState = (checkpoints: Map<string, TaskRunCheckpoint>): string =>
    JSON.stringify(toCheckpointRecord(checkpoints));

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

const decodePayload = (
    payload: PersistedTaskRunCheckpointsV1 | null,
    filePath: string,
): Map<string, TaskRunCheckpoint> => {
    const loaded = new Map<string, TaskRunCheckpoint>();
    if (!payload) {return loaded;}
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
    return loaded;
};

const persistPayloadToFile = async (filePath: string, payload: string): Promise<void> => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, {recursive: true});
    const tmpPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
        await fs.writeFile(tmpPath, payload, 'utf8');
        await fs.rename(tmpPath, filePath);
    } catch (error) {
        await fs.rm(tmpPath, {force: true});
        throw error;
    }
};

const delay = async (durationMs: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, durationMs));
};

const withCheckpointFileLock = async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
    const lockDir = `${filePath}.lock`;
    const owner: CheckpointFileLockOwner = {
        pid: process.pid,
        acquiredAt: Date.now(),
        token: crypto.randomUUID(),
    };
    const deadline = Date.now() + CHECKPOINT_LOCK_WAIT_MS;
    await fs.mkdir(path.dirname(filePath), {recursive: true});

    while (true) {
        try {
            await fs.mkdir(lockDir);
            try {
                await fs.writeFile(path.join(lockDir, 'owner.json'), JSON.stringify(owner), 'utf8');
            } catch (error) {
                await fs.rm(lockDir, {recursive: true, force: true});
                throw error;
            }
            break;
        } catch (error) {
            if (!isExistingPath(error)) {throw error;}
            const staleObservation = await observeStaleDirectoryLock(lockDir, CHECKPOINT_LOCK_STALE_MS);
            if (staleObservation && await reclaimObservedDirectoryLock(lockDir, staleObservation)) {continue;}
            if (Date.now() >= deadline) {
                throw new Error(`task checkpoint store lock timeout: ${filePath}`, {cause: error});
            }
            await delay(CHECKPOINT_LOCK_RETRY_MS);
        }
    }

    try {
        return await operation();
    } finally {
        const currentOwner = await readDirectoryLockOwner(lockDir);
        if (currentOwner?.token === owner.token) {
            await fs.rm(lockDir, {recursive: true, force: true});
        }
    }
};

const mergeCheckpointMaps = (
    persisted: Map<string, TaskRunCheckpoint>,
    local: Map<string, TaskRunCheckpoint>,
    deletedRunIds: ReadonlySet<string>,
): Map<string, TaskRunCheckpoint> => {
    const merged = new Map<string, TaskRunCheckpoint>();
    for (const [runId, checkpoint] of persisted) {
        if (!deletedRunIds.has(runId) || isImmutableTerminal(checkpoint.status)) {
            merged.set(runId, structuredClone(checkpoint));
        }
    }
    for (const [runId, checkpoint] of local) {
        const existing = merged.get(runId);
        if (existing && isImmutableTerminal(existing.status)) {continue;}
        if (!existing || checkpoint.updatedAt >= existing.updatedAt) {
            merged.set(runId, structuredClone(checkpoint));
        }
    }
    return merged;
};

const isImmutableTerminal = (status: RunStatus): boolean =>
    status === 'completed' || status === 'halted';

const createTaskCheckpointStoreBackend = (
    filePath: string,
    opts?: TaskCheckpointStoreOptions,
): TaskCheckpointStore => {
    const checkpoints = new Map<string, TaskRunCheckpoint>();
    const intervalMs = opts?.flushIntervalMs && opts.flushIntervalMs > 0
        ? Math.floor(opts.flushIntervalMs)
        : 1200;
    const injectedPersistPayload = opts?.persistPayload;
    const persistPayload = injectedPersistPayload ?? persistPayloadToFile;
    let activeFlush: Promise<Map<string, TaskRunCheckpoint>> | null = null;
    let loadPromise: Promise<Map<string, TaskRunCheckpoint>> | null = null;
    let loaded = false;
    let lastSnapshot = '';
    let knownRunIds = new Set<string>();

    const load = async (): Promise<Map<string, TaskRunCheckpoint>> => {
        if (loaded) {return checkpoints;}
        if (loadPromise) {return await loadPromise;}
        loadPromise = (async () => {
            if (activeFlush) {await activeFlush;}
            const loadedCheckpoints = decodePayload(await readPayload(filePath), filePath);
            checkpoints.clear();
            for (const [runId, checkpoint] of loadedCheckpoints) {
                checkpoints.set(runId, checkpoint);
            }
            knownRunIds = new Set(loadedCheckpoints.keys());
            lastSnapshot = snapshotState(loadedCheckpoints);
            loaded = true;
            return checkpoints;
        })();
        try {
            return await loadPromise;
        } finally {
            loadPromise = null;
        }
    };

    const persistSnapshot = async (
        localSnapshot: Map<string, TaskRunCheckpoint>,
        deletedRunIds: ReadonlySet<string>,
    ): Promise<Map<string, TaskRunCheckpoint>> => {
        if (injectedPersistPayload) {
            const payload = JSON.stringify(toPayload(localSnapshot), null, 2);
            await persistPayload(filePath, payload);
            return localSnapshot;
        }
        return await withCheckpointFileLock(filePath, async () => {
            const persisted = decodePayload(await readPayload(filePath), filePath);
            const merged = mergeCheckpointMaps(persisted, localSnapshot, deletedRunIds);
            const payload = JSON.stringify(toPayload(merged), null, 2);
            await persistPayload(filePath, payload);
            return merged;
        });
    };

    const flush = async (): Promise<void> => {
        while (true) {
            if (activeFlush) {
                await activeFlush;
                continue;
            }
            const localSnapshot = new Map(
                [...checkpoints.entries()].map(([runId, checkpoint]) => [runId, structuredClone(checkpoint)]),
            );
            decodePayload({
                version: 1,
                savedAt: Date.now(),
                checkpoints: toCheckpointRecord(localSnapshot),
            }, filePath);
            const snapshot = snapshotState(localSnapshot);
            if (snapshot === lastSnapshot) {return;}
            const deletedRunIds = new Set(
                [...knownRunIds].filter((runId) => !localSnapshot.has(runId)),
            );
            const currentFlush = persistSnapshot(localSnapshot, deletedRunIds);
            activeFlush = currentFlush;
            try {
                const persisted = await currentFlush;
                for (const runId of deletedRunIds) {
                    if (!checkpoints.has(runId)) {checkpoints.delete(runId);}
                }
                for (const [runId, checkpoint] of persisted) {
                    const current = checkpoints.get(runId);
                    if (!current
                        || isImmutableTerminal(checkpoint.status)
                        || checkpoint.updatedAt > current.updatedAt) {
                        checkpoints.set(runId, structuredClone(checkpoint));
                    }
                }
                knownRunIds = new Set(persisted.keys());
                lastSnapshot = snapshotState(persisted);
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
        stop: () => {clearInterval(timer);},
    };
};

export const createTaskCheckpointStore = (
    filePath: string,
    opts?: TaskCheckpointStoreOptions,
): TaskCheckpointStore => {
    if (opts?.persistPayload) {
        return createTaskCheckpointStoreBackend(filePath, opts);
    }

    const normalizedPath = path.resolve(filePath);
    let entry = sharedStores.get(normalizedPath);
    if (!entry) {
        entry = {
            store: createTaskCheckpointStoreBackend(normalizedPath, opts),
            references: 0,
        };
        sharedStores.set(normalizedPath, entry);
    }
    entry.references += 1;
    const sharedEntry = entry;
    let stopped = false;

    return {
        checkpoints: sharedEntry.store.checkpoints,
        load: sharedEntry.store.load,
        flush: sharedEntry.store.flush,
        stop: () => {
            if (stopped) {return;}
            stopped = true;
            sharedEntry.references -= 1;
            if (sharedEntry.references === 0) {
                sharedEntry.store.stop();
                sharedStores.delete(normalizedPath);
            }
        },
    };
};
