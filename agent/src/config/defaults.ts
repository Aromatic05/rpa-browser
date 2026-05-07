/**
 * RunnerConfig 默认值。
 */

import type { RunnerConfig } from './config_schema';
import { defaultEntityRuleConfig } from './entity_rules';

export const defaultRunnerConfig: RunnerConfig = {
    waitPolicy: {
        defaultTimeoutMs: 1000,
        interactionTimeoutMs: 6000,
        navigationTimeoutMs: 15000,
        a11ySnapshotTimeoutMs: 5000,
        visibleTimeoutMs: 5000,
        pageReadyTimeoutMs: 1500,
        candidateClickTimeoutMs: 800,
        highlightBeforeActionMs: 250,
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
        consoleLogLevel: 'warning',
        fileLogLevel: 'info',
        traceEnabled: true,
        traceLogArgs: false,
        traceConsoleEnabled: false,
        traceFileEnabled: true,
        traceFilePath: '.artifacts/logs/trace/trace-{ts}.log',
        stepConsoleEnabled: true,
        stepFileEnabled: true,
        stepFilePath: '.artifacts/logs/step/step-{ts}.log',
        actionConsoleEnabled: true,
        actionFileEnabled: true,
        actionFilePath: '.artifacts/logs/action/action-{ts}.log',
        recordConsoleEnabled: true,
        recordFileEnabled: true,
        recordFilePath: '.artifacts/logs/record/record-{ts}.log',
        infraConsoleEnabled: true,
        infraFileEnabled: true,
        infraFilePath: '.artifacts/logs/infra/infra-{ts}.log',
        extConsoleEnabled: true,
        extFileEnabled: true,
        extFilePath: '.artifacts/logs/ext/ext-{ts}.log',
        entityConsoleEnabled: false,
        entityFileEnabled: true,
        entityFilePath: '.artifacts/logs/entity/entity-{ts}.log',
        dslConsoleEnabled: false,
        dslFileEnabled: true,
        dslFilePath: '.artifacts/logs/dsl/dsl-{ts}.log',
        screenshotOnError: false,
    },
    confidencePolicy: {
        enabled: true,
        minScore: 0.6,
        roleWeight: 0.5,
        nameWeight: 0.25,
        textWeight: 0.15,
        selectorBonus: 0.15,
    },
    checkpointPolicy: {
        enabled: true,
        filePath: '.artifacts/checkpoints/task_runs.json',
        flushIntervalMs: 1200,
    },
    mcpPolicy: {
        enabledToolGroups: [],
        enableTools: [],
        disableTools: [
            'browser.read_console',
            'browser.read_network',
            'browser.take_screenshot',
            'browser.mouse',
        ],
    },
    entityRules: defaultEntityRuleConfig,
};
