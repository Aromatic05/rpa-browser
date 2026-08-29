import type {
    AgentEvalComparison,
    AgentEvalHarness,
    AgentEvalMode,
    AgentEvalRun,
    AgentEvalTask,
    AgentEvalVerification,
} from './contracts';
import {collectAgentEvalMetrics} from './metrics';

const normalizeVerification = (
    value: boolean | AgentEvalVerification,
): AgentEvalVerification => typeof value === 'boolean' ? {passed: value} : value;

export type EvaluateAgentTaskOptions = Readonly<{
    trialIndex?: number;
}>;

/**
 * Run a single eval task across the requested modes, once.
 *
 * This is the low-level primitive. For repeated trials and aggregated reports,
 * use `runAgentEvalScenario` from `./harness`.
 */
export const evaluateAgentTask = async (
    harness: AgentEvalHarness,
    task: AgentEvalTask,
    options: EvaluateAgentTaskOptions = {},
): Promise<AgentEvalComparison> => {
    const trialIndex = options.trialIndex ?? 0;
    const modes = harness.modes ?? ['program', 'react-baseline'];
    const runs: Partial<Record<AgentEvalMode, AgentEvalRun>> = {};
    for (const mode of modes) {
        await task.prepare?.(mode, trialIndex);
        const startedAt = performance.now();
        const result = await harness.runner.run({
            prompt: task.prompt,
            provider: task.provider,
            model: task.model,
            executionMode: mode,
            ...(task.input ? {input: structuredClone(task.input)} : {}),
            ...(task.systemPrompt ? {systemPrompt: task.systemPrompt} : {}),
        });
        const durationMs = performance.now() - startedAt;
        const verification = normalizeVerification(await task.verify(result, mode, trialIndex));
        runs[mode] = Object.freeze({
            taskId: task.id,
            mode,
            trialIndex,
            success: verification.passed,
            durationMs,
            verification: structuredClone(verification),
            metrics: collectAgentEvalMetrics(result, mode, verification.passed, durationMs),
            result,
        });
    }
    return Object.freeze({taskId: task.id, runs: Object.freeze(runs)});
};
