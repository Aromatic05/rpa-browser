import type { ExecutorFn } from './steps/executors';
import { stepExecutors } from './steps/executors';

export type RunnerPlugin = {
    version?: string;
    executors: Record<string, ExecutorFn>;
};

export const createRunnerPlugin = (): RunnerPlugin => ({
    executors: stepExecutors,
});

export default createRunnerPlugin;
