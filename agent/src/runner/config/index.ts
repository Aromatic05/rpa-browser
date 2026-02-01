/**
 * RunnerConfig 入口：提供缓存读取与解析。
 */

import type { RunnerConfig } from './config_schema';
import { loadRunnerConfig } from './loader';

let cachedConfig: RunnerConfig | null = null;

export const getRunnerConfig = () => {
    if (!cachedConfig) {
        cachedConfig = loadRunnerConfig();
    }
    return cachedConfig;
};

export const resolveRunnerConfig = (overrides?: Partial<RunnerConfig>) => {
    const base = loadRunnerConfig();
    return { ...base, ...overrides };
};

export type { RunnerConfig } from './config_schema';
