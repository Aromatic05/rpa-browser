/**
 * replay：将录制事件转换为 Step 序列，并通过 runSteps 执行。
 *
 * 设计说明：
 * - 回放不再直接调用旧 execute/action，而是走统一 Step 模型
 * - v0 仅支持带 a11yNodeId 的事件，缺失则返回结构化错误
 */

import crypto from 'crypto';
import type { RecordedEvent } from '../record/recorder';
import type { RunStepsResult } from '../runner/steps/types';
import type { RunStepsRequest, StepUnion } from '../runner/steps/types';
import type { RunStepsDeps } from '../runner/run_steps';
import { runSteps } from '../runner/run_steps';

export type ReplayOptions = {
    clickDelayMs: number;
    stepDelayMs: number;
    scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

type ReplayRequest = {
    workspaceId: string;
    events: RecordedEvent[];
    stopOnError: boolean;
    deps?: RunStepsDeps;
};

type ReplayResult = RunStepsResult & { error?: { code: string; message: string; details?: unknown } };

const buildStepsFromEvents = (events: RecordedEvent[]) => {
    const steps: StepUnion[] = [];
    const unsupported: RecordedEvent[] = [];

    for (const event of events) {
        if (event.type === 'navigate' && event.url) {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.goto',
                args: { url: event.url },
                meta: { source: 'play', ts: event.ts },
            });
            continue;
        }
        if (event.type === 'click' && event.a11yNodeId) {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.click',
                args: { a11yNodeId: event.a11yNodeId },
                meta: { source: 'play', ts: event.ts },
            });
            continue;
        }
        if (event.type === 'input' && event.a11yNodeId && typeof event.value === 'string') {
            steps.push({
                id: crypto.randomUUID(),
                name: 'browser.fill',
                args: { a11yNodeId: event.a11yNodeId, value: event.value },
                meta: { source: 'play', ts: event.ts },
            });
            continue;
        }
        unsupported.push(event);
    }

    return { steps, unsupported };
};

/**
 * replayRecording：将 events 转为 Step 并执行。
 * 若事件缺少 a11yNodeId，则返回 ERR_NOT_IMPLEMENTED。
 */
export const replayRecording = async (req: ReplayRequest): Promise<ReplayResult> => {
    const { steps, unsupported } = buildStepsFromEvents(req.events);
    if (unsupported.length > 0) {
        return {
            ok: false,
            results: [],
            error: {
                code: 'ERR_NOT_IMPLEMENTED',
                message: 'recorded events require a11yNodeId',
                details: unsupported.map((event) => ({ type: event.type, ts: event.ts })),
            },
        };
    }
    const runReq: RunStepsRequest = {
        workspaceId: req.workspaceId,
        steps,
        options: { stopOnError: req.stopOnError },
    };
    return runSteps(runReq, req.deps);
};
