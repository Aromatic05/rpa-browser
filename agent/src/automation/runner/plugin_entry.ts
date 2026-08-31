import { createTraceTools } from './trace/tools';
import type { ExecutorFn } from './steps/executors';
import { stepExecutors } from './steps/executors';

export type CreateTraceToolsFn = typeof createTraceTools;

export type RunnerPlugin = {
    version?: string;
    executors: Record<string, ExecutorFn>;
    createTraceTools: CreateTraceToolsFn;
};

export const createRunnerPlugin = (): RunnerPlugin => ({
    executors: stepExecutors,
    createTraceTools,
});

export default createRunnerPlugin;
