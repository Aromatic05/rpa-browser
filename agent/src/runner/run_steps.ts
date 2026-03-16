/**
 * runSteps：统一 MCP / play / script 的执行入口。
 *
 * 设计说明：
 * - 只接收 Step 列表，避免入口各自拼装 action/command
 * - 执行过程中统一输出 step.start/step.end 事件（Task DSL 雏形）
 * - 通过 RuntimeRegistry 绑定 workspace/tab/page/trace
 */

import crypto from 'node:crypto';
import type { RunStepsRequest, RunStepsResult, StepUnion, StepResult, StepName } from './steps/types';
import type { RuntimeRegistry } from '../runtime/runtime_registry';
import type { RunnerPluginHost } from './hotreload/plugin_host';
import type { RunnerConfig } from './config';
import { getLogger } from '../logging/logger';
import type { StepEnvelope, StepResultEnvelope, TaskCheckpoint, TaskRun, TaskRunStatus } from '../task_stream/types';

const stepLogger = getLogger('step');

export type StepEvent =
    | {
          type: 'step.start';
          ts: number;
          workspaceId: string;
          stepId: string;
          name: StepName;
          argsSummary?: unknown;
      }
    | {
          type: 'step.end';
          ts: number;
          workspaceId: string;
          stepId: string;
          name: StepName;
          ok: boolean;
          durationMs: number;
          error?: StepResult['error'];
      };

export type StepSink = {
    write: (event: StepEvent) => void | Promise<void>;
};

export class MemoryStepSink implements StepSink {
    events: StepEvent[] = [];
    write(event: StepEvent) {
        this.events.push(event);
    }
}

export const createConsoleStepSink = (prefix = '[step]'): StepSink => ({
    write: (event) => {
        if (event.type === 'step.start') {
            const iso = new Date(event.ts).toISOString();
            console.log(
                `${prefix} start ts=${event.ts} iso=${iso} workspace=${event.workspaceId} step=${event.stepId} name=${event.name}`,
            );
        } else {
            const iso = new Date(event.ts).toISOString();
            console.log(
                `${prefix} end ts=${event.ts} iso=${iso} workspace=${event.workspaceId} step=${event.stepId} name=${event.name} ok=${event.ok} ms=${event.durationMs}`,
            );
        }
    },
});

export type RunStepsDeps = {
    runtime: RuntimeRegistry;
    stepSinks?: StepSink[];
    config: RunnerConfig;
    pluginHost: RunnerPluginHost;
};

const executeStep = async (
    step: StepUnion,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    const executors = deps.pluginHost.getExecutors();
    const fn = executors[step.name];
    if (!fn) {
        stepLogger('[runner] missing executor', step.name);
        return {
            stepId: step.id,
            ok: false,
            error: {
                code: 'ERR_NOT_FOUND',
                message: `executor not found for step: ${step.name}`,
            },
        };
    }
    return fn(step, deps, workspaceId);
};

const writeStepEvent = async (sinks: StepSink[] | undefined, event: StepEvent) => {
    if (!sinks || sinks.length === 0) return;
    await Promise.all(sinks.map((sink) => sink.write(event)));
};

let defaultDeps: RunStepsDeps | null = null;

/**
 * setRunStepsDeps：设置默认依赖（用于 MCP/play/script 共用的全局执行入口）。
 */
export const setRunStepsDeps = (deps: RunStepsDeps) => {
    defaultDeps = deps;
};

/**
 * runSteps：统一入口函数。若未显式传 deps，则使用默认依赖。
 */
export const runSteps = async (req: RunStepsRequest, deps?: RunStepsDeps): Promise<RunStepsResult> => {
    const resolvedDeps = deps || defaultDeps;
    if (!resolvedDeps) {
        return {
            ok: false,
            results: req.steps.map((step) => ({
                stepId: step.id,
                ok: false,
                error: { code: 'ERR_NOT_READY', message: 'runSteps deps not initialized' },
            })),
        };
    }

    const results: StepResult[] = [];
    for (const step of req.steps) {
        const startTs = Date.now();
        await writeStepEvent(resolvedDeps.stepSinks, {
            type: 'step.start',
            ts: startTs,
            workspaceId: req.workspaceId,
            stepId: step.id,
            name: step.name,
            argsSummary: step.args,
        });

        const result = await executeStep(step, resolvedDeps, req.workspaceId);

        results.push(result);
        await writeStepEvent(resolvedDeps.stepSinks, {
            type: 'step.end',
            ts: Date.now(),
            workspaceId: req.workspaceId,
            stepId: step.id,
            name: step.name,
            ok: result.ok,
            durationMs: Date.now() - startTs,
            error: result.ok ? undefined : result.error,
        });

        if (!result.ok && req.options?.stopOnError) {
            return { ok: false, results };
        }
    }

    return { ok: results.every((r) => r.ok), results };
};

const toOutputs = (value: unknown): Record<string, unknown> | undefined => {
    if (value == null) return undefined;
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return { value };
};

export type RunStepsQueueManager = {
    createRun: (args: { taskId: string; workspaceId: string; runId?: string }) => TaskRun;
    getRun: (runId: string) => TaskRun | null;
    pushSteps: (args: {
        runId: string;
        steps: StepEnvelope[];
        stopOnError?: boolean;
    }) => Promise<{ ok: boolean; accepted: number; emitted: number; checkpoint: TaskCheckpoint }>;
    pollResults: (args: {
        runId: string;
        cursor?: number;
        limit?: number;
    }) => { items: StepResultEnvelope[]; nextCursor: number; status: TaskRunStatus; done: boolean };
    checkpoint: (runId: string) => TaskCheckpoint;
    abortRun: (runId: string) => TaskCheckpoint;
};

export const createRunStepsQueueManager = (): RunStepsQueueManager => {
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
            const result = await runSteps({
                workspaceId: run.workspaceId,
                steps: reqSteps,
                options: { stopOnError: stopOnError ?? true },
            });

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

            return {
                ok: result.ok,
                accepted: normalized.length,
                emitted: emittedBatch.length,
                checkpoint: toCheckpoint(run),
            };
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
