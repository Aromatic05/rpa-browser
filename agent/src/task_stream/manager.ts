import crypto from 'node:crypto';
import { runSteps } from '../runner/run_steps';
import type { StepUnion } from '../runner/steps/types';
import type { StepEnvelope, StepResultEnvelope, TaskCheckpoint, TaskRun, TaskRunStatus } from './types';

const toOutputs = (value: unknown): Record<string, unknown> | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { value };
};

const asError = (error: unknown) => {
    if (error && typeof error === 'object' && 'code' in (error as Record<string, unknown>) && 'message' in (error as Record<string, unknown>)) {
        return error as { code: string; message: string; details?: unknown };
    }
    return { code: 'ERR_ASSERTION_FAILED', message: error instanceof Error ? error.message : String(error) };
};

export type TaskRunManager = {
    createRun: (args: { taskId: string; workspaceId: string; runId?: string }) => TaskRun;
    getRun: (runId: string) => TaskRun | null;
    pushSteps: (args: { runId: string; steps: StepEnvelope[]; stopOnError?: boolean }) => Promise<{ ok: boolean; accepted: number; emitted: number; checkpoint: TaskCheckpoint }>;
    pollResults: (args: { runId: string; cursor?: number; limit?: number }) => { items: StepResultEnvelope[]; nextCursor: number; status: TaskRunStatus; done: boolean };
    checkpoint: (runId: string) => TaskCheckpoint;
    abortRun: (runId: string) => TaskCheckpoint;
};

export const createTaskRunManager = (): TaskRunManager => {
    const runs = new Map<string, TaskRun>();

    const getRunOrThrow = (runId: string) => {
        const run = runs.get(runId);
        if (!run) throw new Error('task run not found');
        return run;
    };

    const toCheckpoint = (run: TaskRun): TaskCheckpoint => ({
        runId: run.runId,
        taskId: run.taskId,
        workspaceId: run.workspaceId,
        status: run.status,
        nextSeq: run.nextSeq,
        emittedCount: run.emitted.length,
        lastError: run.lastError,
        updatedAt: run.updatedAt,
    });

    return {
        createRun: ({ taskId, workspaceId, runId }) => {
            const id = runId || crypto.randomUUID();
            const now = Date.now();
            const run: TaskRun = {
                runId: id,
                taskId,
                workspaceId,
                status: 'running',
                nextSeq: 0,
                emitted: [],
                createdAt: now,
                updatedAt: now,
            };
            runs.set(id, run);
            return run;
        },
        getRun: (runId: string) => runs.get(runId) || null,
        pushSteps: async ({ runId, steps, stopOnError }) => {
            const run = getRunOrThrow(runId);
            if (run.status !== 'running') {
                throw new Error(`task run is not running: ${run.status}`);
            }
            if (!Array.isArray(steps) || steps.length === 0) {
                return { ok: true, accepted: 0, emitted: 0, checkpoint: toCheckpoint(run) };
            }

            const normalized = steps.map((item, index) => {
                const seq = typeof item.seq === 'number' ? item.seq : run.nextSeq + index;
                return { seq, step: item.step };
            });
            const outOfOrder = normalized.some((item, index) => item.seq !== run.nextSeq + index);
            if (outOfOrder) {
                throw new Error('step sequence must be contiguous');
            }

            const reqSteps = normalized.map((item) => item.step as StepUnion);
            const result = await runSteps({ workspaceId: run.workspaceId, steps: reqSteps, options: { stopOnError: stopOnError ?? true } });

            const now = Date.now();
            const emittedBatch: StepResultEnvelope[] = result.results.map((entry, index) => {
                const seq = normalized[index]?.seq ?? run.nextSeq + index;
                return {
                    runId: run.runId,
                    taskId: run.taskId,
                    workspaceId: run.workspaceId,
                    seq,
                    stepId: entry.stepId,
                    ok: entry.ok,
                    status: entry.ok ? 'ok' : 'error',
                    outputs: toOutputs(entry.data),
                    raw: entry.data,
                    error: entry.error,
                    ts: now,
                };
            });
            run.emitted.push(...emittedBatch);
            run.nextSeq += normalized.length;
            run.updatedAt = now;

            if (!result.ok) {
                run.status = 'failed';
                const firstFailed = result.results.find((item) => !item.ok);
                run.lastError = firstFailed?.error || { code: 'ERR_ASSERTION_FAILED', message: 'task run failed' };
            }

            if (result.ok && emittedBatch.length > 0 && emittedBatch.every((item) => item.ok)) {
                // keep running; caller controls completion timing.
            }

            return { ok: result.ok, accepted: normalized.length, emitted: emittedBatch.length, checkpoint: toCheckpoint(run) };
        },
        pollResults: ({ runId, cursor, limit }) => {
            const run = getRunOrThrow(runId);
            const start = typeof cursor === 'number' && cursor >= 0 ? cursor : 0;
            const max = typeof limit === 'number' && limit > 0 ? limit : 100;
            const items = run.emitted.slice(start, start + max);
            const nextCursor = start + items.length;
            const done = run.status !== 'running' && nextCursor >= run.emitted.length;
            return { items, nextCursor, status: run.status, done };
        },
        checkpoint: (runId: string) => {
            const run = getRunOrThrow(runId);
            return toCheckpoint(run);
        },
        abortRun: (runId: string) => {
            const run = getRunOrThrow(runId);
            run.status = 'aborted';
            run.updatedAt = Date.now();
            return toCheckpoint(run);
        },
    };
};
