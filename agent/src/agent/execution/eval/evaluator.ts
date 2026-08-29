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

export const evaluateAgentTask = async (
    harness: AgentEvalHarness,
    task: AgentEvalTask,
): Promise<AgentEvalComparison> => {
    const modes = harness.modes ?? ['program', 'react-baseline'];
    const runs: Partial<Record<AgentEvalMode, AgentEvalRun>> = {};
    for (const mode of modes) {
        await task.prepare?.(mode);
        const result = await harness.runner.run({
            prompt: task.prompt,
            provider: task.provider,
            model: task.model,
            executionMode: mode,
            ...(task.input ? {input: structuredClone(task.input)} : {}),
            ...(task.systemPrompt ? {systemPrompt: task.systemPrompt} : {}),
        });
        const verification = normalizeVerification(await task.verify(result, mode));
        runs[mode] = Object.freeze({
            taskId: task.id,
            mode,
            success: verification.passed,
            verification: structuredClone(verification),
            metrics: collectAgentEvalMetrics(result, mode),
            result,
        });
    }
    return Object.freeze({taskId: task.id, runs: Object.freeze(runs)});
};
