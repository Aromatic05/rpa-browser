/**
 * replay：执行录制产出的 Step 序列。
 *
 * 设计说明：
 * - 回放不再直接调用旧 execute/action，而是走统一 Step 模型
 * - 当前录制已统一为 Step 序列
 */

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
    steps: StepUnion[];
    stopOnError: boolean;
    deps?: RunStepsDeps;
};

type ReplayResult = RunStepsResult & { error?: { code: string; message: string; details?: unknown } };

/**
 * replayRecording：执行已录制的 Step 列表。
 */
export const replayRecording = async (req: ReplayRequest): Promise<ReplayResult> => {
    const runReq: RunStepsRequest = {
        workspaceId: req.workspaceId,
        steps: req.steps,
        options: { stopOnError: req.stopOnError },
    };
    const result = await runSteps(runReq, req.deps);
    return result;
};
