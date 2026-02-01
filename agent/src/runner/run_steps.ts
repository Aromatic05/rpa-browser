/**
 * runSteps：统一 MCP / play / script 的执行入口。
 *
 * 设计说明：
 * - 只接收 Step 列表，避免入口各自拼装 action/command
 * - 执行过程中统一输出 step.start/step.end 事件（Task DSL 雏形）
 * - 通过 RuntimeRegistry 绑定 workspace/tab/page/trace
 */

import type { RunStepsRequest, RunStepsResult, StepUnion, StepResult, StepName } from './steps/types';
import type { RuntimeRegistry } from '../runtime/runtime_registry';
import { executeBrowserClick } from './steps/executors/click';
import { executeBrowserFill } from './steps/executors/fill';
import { executeBrowserGoto } from './steps/executors/goto';
import { executeBrowserSnapshot } from './steps/executors/snapshot';

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
            console.log(
                `${prefix} start workspace=${event.workspaceId} step=${event.stepId} name=${event.name}`,
            );
        } else {
            console.log(
                `${prefix} end workspace=${event.workspaceId} step=${event.stepId} name=${event.name} ok=${event.ok} ms=${event.durationMs}`,
            );
        }
    },
});

export type RunStepsDeps = {
    runtime: RuntimeRegistry;
    stepSinks?: StepSink[];
};

const executeStep = async (
    step: StepUnion,
    deps: RunStepsDeps,
    workspaceId: string,
): Promise<StepResult> => {
    switch (step.name) {
        case 'browser.goto':
            return executeBrowserGoto(step, deps, workspaceId);
        case 'browser.snapshot':
            return executeBrowserSnapshot(step, deps, workspaceId);
        case 'browser.click':
            return executeBrowserClick(step, deps, workspaceId);
        case 'browser.fill':
            return executeBrowserFill(step, deps, workspaceId);
        default:
            return {
                stepId: (step as StepUnion).id,
                ok: false,
                error: {
                    code: 'ERR_NOT_IMPLEMENTED',
                    message: `unsupported step: ${(step as StepUnion).name}`,
                },
            };
    }
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
