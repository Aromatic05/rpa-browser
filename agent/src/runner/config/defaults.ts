/**
 * RunnerConfig 默认值。
 */

import type { RunnerConfig } from './config_schema';

export const defaultRunnerConfig: RunnerConfig = {
    waitPolicy: {
        defaultTimeoutMs: 5000,
        navigationTimeoutMs: 15000,
        a11ySnapshotTimeoutMs: 5000,
        visibleTimeoutMs: 5000,
        settleTimeoutMs: 800,
    },
    retryPolicy: {
        enabled: false,
        maxAttempts: 2,
        backoffMs: 300,
        retryableErrorCodes: ['ERR_TIMEOUT', 'ERR_NOT_INTERACTABLE'],
    },
    humanPolicy: {
        enabled: true,
        clickDelayMsRange: { min: 200, max: 600 },
        typeDelayMsRange: { min: 20, max: 80 },
        scrollStepPxRange: { min: 160, max: 360 },
        scrollDelayMsRange: { min: 30, max: 90 },
        idleBehavior: 'none',
    },
    observability: {
        traceEnabled: true,
        traceLogArgs: false,
        traceFileEnabled: false,
        traceFilePath: '.artifacts/trace/trace.log',
        stepLogLevel: 'info',
        screenshotOnError: false,
    },
};
