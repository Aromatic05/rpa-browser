import type {AgentEvalMetrics, AgentEvalMode, AgentEvalRun} from './contracts';

export type AgentEvalNumericDistribution = Readonly<{
    count: number;
    sum: number;
    min: number;
    max: number;
    mean: number;
}>;

export type AgentEvalBooleanRate = Readonly<{
    count: number;
    passed: number;
    rate: number;
}>;

export type AgentEvalUnknownDistribution = Readonly<{
    unknown: true;
}>;

export type AgentEvalModeAggregate = Readonly<{
    mode: AgentEvalMode;
    trials: number;
    taskSuccess: AgentEvalBooleanRate;
    recoverySuccess: AgentEvalBooleanRate | AgentEvalUnknownDistribution;
    durationMs: AgentEvalNumericDistribution;
    turns: AgentEvalNumericDistribution;
    toolCalls: AgentEvalNumericDistribution;
    readCalls: AgentEvalNumericDistribution;
    controlCalls: AgentEvalNumericDistribution;
    effectCalls: AgentEvalNumericDistribution;
    failedToolCalls: AgentEvalNumericDistribution;
    postErrorEffectCalls: AgentEvalNumericDistribution;
    failedWorldChangingEffects: AgentEvalNumericDistribution | AgentEvalUnknownDistribution;
    compensationEffects: AgentEvalNumericDistribution | AgentEvalUnknownDistribution;
    worldEffectCalls: AgentEvalNumericDistribution | AgentEvalUnknownDistribution;
    repair: Readonly<{
        rewindCalls: AgentEvalNumericDistribution;
        rollbackCalls: AgentEvalNumericDistribution;
        patchCalls: AgentEvalNumericDistribution;
        recomputeCalls: AgentEvalNumericDistribution;
        refreshCalls: AgentEvalNumericDistribution;
    }>;
}>;

const numericDistribution = (values: readonly number[]): AgentEvalNumericDistribution | null => {
    const numbers = values.filter((v): v is number => typeof v === 'number');
    if (numbers.length === 0) {
        return null;
    }
    const sum = numbers.reduce((acc, value) => acc + value, 0);
    const min = Math.min(...numbers);
    const max = Math.max(...numbers);
    const mean = sum / numbers.length;
    return Object.freeze({count: numbers.length, sum, min, max, mean});
};

const booleanRate = (values: ReadonlyArray<boolean | null>): AgentEvalBooleanRate | null => {
    const booleans = values.filter((v): v is boolean => typeof v === 'boolean');
    if (booleans.length === 0) {
        return null;
    }
    const passed = booleans.filter(Boolean).length;
    return Object.freeze({count: booleans.length, passed, rate: passed / booleans.length});
};

const requiredDistribution = (
    values: readonly number[],
): AgentEvalNumericDistribution => {
    const distribution = numericDistribution(values);
    if (!distribution) {
        throw new Error('Unexpected empty distribution');
    }
    return distribution;
};

const optionalDistribution = (
    values: ReadonlyArray<number | null>,
): AgentEvalNumericDistribution | AgentEvalUnknownDistribution => {
    const distribution = numericDistribution(values as number[]);
    return distribution ?? {unknown: true as const};
};

const optionalRate = (
    values: ReadonlyArray<boolean | null>,
): AgentEvalBooleanRate | AgentEvalUnknownDistribution => {
    const rate = booleanRate(values);
    return rate ?? {unknown: true as const};
};

export const computeAgentEvalAggregates = (
    runs: Readonly<Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>>>,
): Readonly<Partial<Record<AgentEvalMode, AgentEvalModeAggregate>>> => {
    const aggregates: Partial<Record<AgentEvalMode, AgentEvalModeAggregate>> = {};
    for (const [mode, modeRuns] of Object.entries(runs) as [AgentEvalMode, readonly AgentEvalRun[] | undefined][]) {
        if (!modeRuns || modeRuns.length === 0) {
            continue;
        }
        const metrics = modeRuns.map((run) => run.metrics);
        aggregates[mode] = Object.freeze({
            mode,
            trials: modeRuns.length,
            taskSuccess: optionalRate(metrics.map((m) => m.taskSuccess)) as AgentEvalBooleanRate,
            recoverySuccess: optionalRate(metrics.map((m) => m.recoverySuccess)),
            durationMs: requiredDistribution(metrics.map((m) => m.durationMs)),
            turns: requiredDistribution(metrics.map((m) => m.turns)),
            toolCalls: requiredDistribution(metrics.map((m) => m.toolCalls)),
            readCalls: requiredDistribution(metrics.map((m) => m.readCalls)),
            controlCalls: requiredDistribution(metrics.map((m) => m.controlCalls)),
            effectCalls: requiredDistribution(metrics.map((m) => m.effectCalls)),
            failedToolCalls: requiredDistribution(metrics.map((m) => m.failedToolCalls)),
            postErrorEffectCalls: requiredDistribution(metrics.map((m) => m.postErrorEffectCalls)),
            failedWorldChangingEffects: optionalDistribution(metrics.map((m) => m.effects.failedWorldChangingEffects)),
            compensationEffects: optionalDistribution(metrics.map((m) => m.effects.compensationEffects)),
            worldEffectCalls: optionalDistribution(metrics.map((m) => m.effects.worldEffectCalls)),
            repair: Object.freeze({
                rewindCalls: requiredDistribution(metrics.map((m) => m.repair.rewindCalls)),
                rollbackCalls: requiredDistribution(metrics.map((m) => m.repair.rollbackCalls)),
                patchCalls: requiredDistribution(metrics.map((m) => m.repair.patchCalls)),
                recomputeCalls: requiredDistribution(metrics.map((m) => m.repair.recomputeCalls)),
                refreshCalls: requiredDistribution(metrics.map((m) => m.repair.refreshCalls)),
            }),
        });
    }
    return Object.freeze(aggregates);
};
