/**
 * 配置加载器：负责读取本地配置文件并合并环境变量覆盖。
 *
 * 约定：
 * - 默认读取 .rpa/runner_config.json（可用 RUNNER_CONFIG_PATH 覆盖）
 * - 环境变量以 RUNNER_ 前缀覆盖默认值（仅支持常用字段）
 * - 采用浅层对象递归合并（仅 JSON）
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultRunnerConfig } from './defaults';
import type { RunnerConfig } from './config_schema';

const defaultConfigPath = () =>
    path.resolve(process.cwd(), '.rpa/runner_config.json');

const readJsonIfExists = (filePath: string): Partial<RunnerConfig> | null => {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as Partial<RunnerConfig>;
    } catch {
        return null;
    }
};

const mergeDeep = <T extends Record<string, any>>(base: T, patch?: Partial<T>): T => {
    if (!patch) return base;
    const out: any = Array.isArray(base) ? [...base] : { ...base };
    for (const [key, value] of Object.entries(patch)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
            out[key] = mergeDeep(out[key] || {}, value as any);
        } else if (value !== undefined) {
            out[key] = value;
        }
    }
    return out as T;
};

const envNumber = (name: string) =>
    process.env[name] !== undefined ? Number(process.env[name]) : undefined;

const envBool = (name: string) =>
    process.env[name] !== undefined ? process.env[name] === 'true' : undefined;

const applyEnvOverrides = (config: RunnerConfig): RunnerConfig => {
    const patch: Partial<RunnerConfig> = {};
    const set = (path: string[], value: unknown) => {
        if (value === undefined) return;
        let cursor: any = patch;
        for (let i = 0; i < path.length - 1; i += 1) {
            const key = path[i];
            cursor[key] = cursor[key] || {};
            cursor = cursor[key];
        }
        cursor[path[path.length - 1]] = value;
    };

    set(['waitPolicy', 'defaultTimeoutMs'], envNumber('RUNNER_DEFAULT_TIMEOUT_MS'));
    set(['waitPolicy', 'navigationTimeoutMs'], envNumber('RUNNER_NAVIGATION_TIMEOUT_MS'));
    set(['waitPolicy', 'a11ySnapshotTimeoutMs'], envNumber('RUNNER_A11Y_SNAPSHOT_TIMEOUT_MS'));
    set(['waitPolicy', 'visibleTimeoutMs'], envNumber('RUNNER_VISIBLE_TIMEOUT_MS'));
    set(['waitPolicy', 'settleTimeoutMs'], envNumber('RUNNER_SETTLE_TIMEOUT_MS'));
    set(['retryPolicy', 'enabled'], envBool('RUNNER_RETRY_ENABLED'));
    set(['retryPolicy', 'maxAttempts'], envNumber('RUNNER_RETRY_MAX_ATTEMPTS'));
    set(['retryPolicy', 'backoffMs'], envNumber('RUNNER_RETRY_BACKOFF_MS'));
    set(['humanPolicy', 'enabled'], envBool('RUNNER_HUMAN_ENABLED'));
    set(['humanPolicy', 'clickDelayMsRange', 'min'], envNumber('RUNNER_CLICK_DELAY_MIN_MS'));
    set(['humanPolicy', 'clickDelayMsRange', 'max'], envNumber('RUNNER_CLICK_DELAY_MAX_MS'));
    set(['humanPolicy', 'typeDelayMsRange', 'min'], envNumber('RUNNER_TYPE_DELAY_MIN_MS'));
    set(['humanPolicy', 'typeDelayMsRange', 'max'], envNumber('RUNNER_TYPE_DELAY_MAX_MS'));
    set(['observability', 'traceEnabled'], envBool('RUNNER_TRACE_ENABLED'));
    set(['observability', 'traceLogArgs'], envBool('RUNNER_TRACE_LOG_ARGS'));

    return mergeDeep(config, patch);
};

export const loadRunnerConfig = (opts?: { configPath?: string }): RunnerConfig => {
    const filePath = opts?.configPath || process.env.RUNNER_CONFIG_PATH || defaultConfigPath();
    const fileConfig = readJsonIfExists(filePath);
    const merged = mergeDeep(defaultRunnerConfig, fileConfig || undefined);
    return applyEnvOverrides(merged);
};
