import fs from 'node:fs/promises';
import path from 'node:path';
import type { Checkpoint } from './run_steps_types';

export type TaskRunCheckpoint = Checkpoint & {
    workspaceId: string;
    nextSeq: number;
    lastAckSeq: number;
};

type PersistedTaskRunCheckpointsV1 = {
    version: 1;
    savedAt: number;
    checkpoints: Record<string, TaskRunCheckpoint>;
};

const toPayload = (checkpoints: Map<string, TaskRunCheckpoint>): PersistedTaskRunCheckpointsV1 => ({
    version: 1,
    savedAt: Date.now(),
    checkpoints: Object.fromEntries(checkpoints.entries()),
});

const readPayload = async (filePath: string): Promise<PersistedTaskRunCheckpointsV1 | null> => {
    try {
        const raw = await fs.readFile(filePath, 'utf8');
        const parsed = JSON.parse(raw) as PersistedTaskRunCheckpointsV1;
        if (parsed?.version !== 1 || !parsed.checkpoints || typeof parsed.checkpoints !== 'object') {
            return null;
        }
        return parsed;
    } catch {
        return null;
    }
};

const persist = async (filePath: string, checkpoints: Map<string, TaskRunCheckpoint>) => {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    const payload = JSON.stringify(toPayload(checkpoints), null, 2);
    await fs.writeFile(tmpPath, payload, 'utf8');
    await fs.rename(tmpPath, filePath);
};

export const createTaskCheckpointStore = (filePath: string, opts?: { flushIntervalMs?: number }) => {
    const checkpoints = new Map<string, TaskRunCheckpoint>();
    const intervalMs = opts?.flushIntervalMs && opts.flushIntervalMs > 0 ? Math.floor(opts.flushIntervalMs) : 1200;
    let writing = false;
    let lastSnapshot = '';

    const load = async () => {
        const payload = await readPayload(filePath);
        checkpoints.clear();
        if (!payload) {return checkpoints;}
        for (const [runId, cp] of Object.entries(payload.checkpoints)) {
            if (!runId || !cp || typeof cp !== 'object') {continue;}
            if (!cp.workspaceId || typeof cp.cursor !== 'number') {continue;}
            checkpoints.set(runId, {
                runId,
                workspaceId: cp.workspaceId,
                status: cp.status,
                cursor: cp.cursor,
                nextSeq: typeof cp.nextSeq === 'number' ? cp.nextSeq : cp.cursor,
                lastAckSeq: typeof cp.lastAckSeq === 'number' ? cp.lastAckSeq : Math.max(-1, cp.cursor - 1),
                updatedAt: cp.updatedAt || Date.now(),
            });
        }
        return checkpoints;
    };

    const flush = async () => {
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
    timer.unref?.();

    return {
        checkpoints,
        load,
        flush,
        stop: () => { clearInterval(timer); },
    };
};
