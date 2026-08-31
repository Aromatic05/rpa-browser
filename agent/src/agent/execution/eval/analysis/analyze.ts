import type {AgentEvalMode, AgentEvalRun} from '../contracts';
import type {AgentEvalCorpusReport} from '../corpus';
import type {AgentEvalScenarioReport} from '../harness';
import type {BootstrapOptions} from './bootstrap';
import {
    DEFAULT_BOOTSTRAP_ITERATIONS,
    DEFAULT_BOOTSTRAP_LEVEL,
    analysisBootstrapSeed,
    cohensDz,
    cohensH,
    pairedMeanDeltaCI,
    pairedRateDeltaCI,
} from './bootstrap';
import type {
    AgentEvalAggregateAnalysis,
    AgentEvalAnalysis,
    AgentEvalAnalysisContextMetricKey,
    AgentEvalAnalysisJournalMetricKey,
    AgentEvalAnalysisMetricKey,
    AgentEvalAnalysisOptions,
    AgentEvalFailureCategory,
    AgentEvalScenarioAnalysis,
    MatchedTrial,
    ObservableContextMetric,
    ObservableJournalMetric,
    PairedBooleanDelta,
    PairedNumericDelta,
    PairedRecoveryDelta,
    UnmatchedTrial,
} from './contracts';
import {
    AGENT_EVAL_ANALYSIS_CONTEXT_METRICS,
    AGENT_EVAL_ANALYSIS_JOURNAL_METRICS,
    AGENT_EVAL_ANALYSIS_METRICS,
    AGENT_EVAL_ANALYSIS_VERSION,
} from './contracts';
import {countFailureTaxonomy} from './failure';
import {pairScenarioRuns, recoveryOf} from './pairing';

const metricAccessors: Readonly<Record<AgentEvalAnalysisMetricKey, (run: AgentEvalRun) => number>> = {
    turns: (run) => run.metrics.turns,
    toolCalls: (run) => run.metrics.toolCalls,
    readCalls: (run) => run.metrics.readCalls,
    controlCalls: (run) => run.metrics.controlCalls,
    effectCalls: (run) => run.metrics.effectCalls,
    postErrorEffectCalls: (run) => run.metrics.postErrorEffectCalls,
    durationMs: (run) => run.metrics.durationMs,
};

const journalAccessors: Readonly<Record<
    AgentEvalAnalysisJournalMetricKey,
    (run: AgentEvalRun) => number | null
>> = {
    failedWorldChangingEffects: (run) => run.metrics.effects.failedWorldChangingEffects,
    compensationEffects: (run) => run.metrics.effects.compensationEffects,
    worldEffectCalls: (run) => run.metrics.effects.worldEffectCalls,
};

const contextAccessors: Readonly<Record<
    AgentEvalAnalysisContextMetricKey,
    (run: AgentEvalRun) => number | null
>> = {
    peakChars: (run) => run.metrics.context.peakChars,
    peakBytes: (run) => run.metrics.context.peakBytes,
    lastChars: (run) => run.metrics.context.lastChars,
    lastBytes: (run) => run.metrics.context.lastBytes,
};

const meanOf = (values: readonly number[]): number =>
    values.reduce((acc, value) => acc + value, 0) / values.length;

const pairedNumericDelta = (
    pairs: readonly MatchedTrial[],
    key: AgentEvalAnalysisMetricKey,
    scope: string,
    bootstrap: BootstrapOptions,
): PairedNumericDelta => {
    if (pairs.length === 0) {
        return Object.freeze({
            pairs: 0,
            programMean: null,
            baselineMean: null,
            meanDelta: null,
            ci: null,
            cohensDz: null,
        });
    }
    const diffs = pairs.map(
        (pair) => metricAccessors[key](pair.program) - metricAccessors[key](pair.baseline),
    );
    const programMean = meanOf(pairs.map((pair) => metricAccessors[key](pair.program)));
    const baselineMean = meanOf(pairs.map((pair) => metricAccessors[key](pair.baseline)));
    return Object.freeze({
        pairs: pairs.length,
        programMean,
        baselineMean,
        meanDelta: programMean - baselineMean,
        ci: pairedMeanDeltaCI(diffs, {
            ...bootstrap,
            seed: analysisBootstrapSeed(bootstrap.seed, scope, key, 'numeric'),
        }),
        cohensDz: cohensDz(diffs),
    });
};

const pairedBooleanDelta = (
    pairs: readonly MatchedTrial[],
    programOk: (run: AgentEvalRun) => boolean,
    baselineOk: (run: AgentEvalRun) => boolean,
    scope: string,
    kind: string,
    bootstrap: BootstrapOptions,
): PairedBooleanDelta => {
    const n = pairs.length;
    let win = 0;
    let loss = 0;
    let tie = 0;
    let program = 0;
    let baseline = 0;
    const binaries: Array<{program: boolean; baseline: boolean}> = [];
    for (const pair of pairs) {
        const programPass = programOk(pair.program);
        const baselinePass = baselineOk(pair.baseline);
        binaries.push({program: programPass, baseline: baselinePass});
        if (programPass) {
            program += 1;
        }
        if (baselinePass) {
            baseline += 1;
        }
        if (programPass && !baselinePass) {
            win += 1;
        } else if (!programPass && baselinePass) {
            loss += 1;
        } else {
            tie += 1;
        }
    }
    if (n === 0) {
        return Object.freeze({
            pairs: 0,
            programRate: null,
            baselineRate: null,
            delta: null,
            win: 0,
            loss: 0,
            tie: 0,
            ci: null,
            cohensH: null,
        });
    }
    const programRate = program / n;
    const baselineRate = baseline / n;
    return Object.freeze({
        pairs: n,
        programRate,
        baselineRate,
        delta: programRate - baselineRate,
        win,
        loss,
        tie,
        ci: pairedRateDeltaCI(binaries, {
            ...bootstrap,
            seed: analysisBootstrapSeed(bootstrap.seed, scope, kind, 'rate'),
        }),
        cohensH: cohensH(programRate, baselineRate),
    });
};

const pairedRecoveryDelta = (
    pairs: readonly MatchedTrial[],
    scope: string,
    bootstrap: BootstrapOptions,
): PairedRecoveryDelta => {
    const states = pairs.map((pair) => ({
        program: recoveryOf(pair.program),
        baseline: recoveryOf(pair.baseline),
    }));
    const known = states.filter((state) => state.program !== null && state.baseline !== null);
    const programKnown = states.filter((state) => state.program !== null).length;
    const baselineKnown = states.filter((state) => state.baseline !== null).length;
    let win = 0;
    let loss = 0;
    let tie = 0;
    let program = 0;
    let baseline = 0;
    for (const state of known) {
        const programPass = state.program === true;
        const baselinePass = state.baseline === true;
        if (programPass) {
            program += 1;
        }
        if (baselinePass) {
            baseline += 1;
        }
        if (programPass && !baselinePass) {
            win += 1;
        } else if (!programPass && baselinePass) {
            loss += 1;
        } else {
            tie += 1;
        }
    }
    const n = known.length;
    const empty: PairedRecoveryDelta = {
        pairs: pairs.length,
        knownPairs: n,
        programKnown,
        baselineKnown,
        unknownProgram: pairs.length - programKnown,
        unknownBaseline: pairs.length - baselineKnown,
        programRate: null,
        baselineRate: null,
        delta: null,
        win: 0,
        loss: 0,
        tie: 0,
        ci: null,
        cohensH: null,
    };
    if (n === 0) {
        return Object.freeze(empty);
    }
    const programRate = program / n;
    const baselineRate = baseline / n;
    return Object.freeze({
        ...empty,
        programRate,
        baselineRate,
        delta: programRate - baselineRate,
        win,
        loss,
        tie,
        ci: pairedRateDeltaCI(
            known.map((state) => ({
                program: state.program === true,
                baseline: state.baseline === true,
            })),
            {
                ...bootstrap,
                seed: analysisBootstrapSeed(bootstrap.seed, scope, 'recovery', 'rate'),
            },
        ),
        cohensH: cohensH(programRate, baselineRate),
    });
};

const observableJournalMetric = (
    pairs: readonly MatchedTrial[],
    key: AgentEvalAnalysisJournalMetricKey,
    scope: string,
    bootstrap: BootstrapOptions,
): ObservableJournalMetric => {
    const programValues: number[] = [];
    const baselineValues: number[] = [];
    for (const pair of pairs) {
        const programValue = journalAccessors[key](pair.program);
        const baselineValue = journalAccessors[key](pair.baseline);
        if (programValue !== null) {
            programValues.push(programValue);
        }
        if (baselineValue !== null) {
            baselineValues.push(baselineValue);
        }
    }
    const pairedValues = pairs.flatMap((pair) => {
        const programValue = journalAccessors[key](pair.program);
        const baselineValue = journalAccessors[key](pair.baseline);
        if (programValue === null || baselineValue === null) {
            return [];
        }
        return [{programValue, baselineValue}];
    });
    if (pairedValues.length === 0) {
        return Object.freeze({
            programObservable: programValues.length,
            baselineObservable: baselineValues.length,
            pairs: 0,
            programMean: programValues.length > 0 ? meanOf(programValues) : null,
            baselineMean: baselineValues.length > 0 ? meanOf(baselineValues) : null,
            meanDelta: null,
            ci: null,
            unknown: true,
        });
    }
    const diffs = pairedValues.map((value) => value.programValue - value.baselineValue);
    return Object.freeze({
        programObservable: programValues.length,
        baselineObservable: baselineValues.length,
        pairs: pairedValues.length,
        programMean: meanOf(programValues),
        baselineMean: meanOf(baselineValues),
        meanDelta: meanOf(diffs),
        ci: pairedMeanDeltaCI(diffs, {
            ...bootstrap,
            seed: analysisBootstrapSeed(bootstrap.seed, scope, key, 'journal'),
        }),
        unknown: false,
    });
};

const observableContextMetric = (
    pairs: readonly MatchedTrial[],
    key: AgentEvalAnalysisContextMetricKey,
    scope: string,
    bootstrap: BootstrapOptions,
): ObservableContextMetric => {
    const total = pairs.length;
    const programValues: number[] = [];
    const baselineValues: number[] = [];
    const pairedValues: Array<{programValue: number; baselineValue: number}> = [];
    for (const pair of pairs) {
        const programValue = contextAccessors[key](pair.program);
        const baselineValue = contextAccessors[key](pair.baseline);
        if (programValue !== null) {
            programValues.push(programValue);
        }
        if (baselineValue !== null) {
            baselineValues.push(baselineValue);
        }
        if (programValue !== null && baselineValue !== null) {
            pairedValues.push({programValue, baselineValue});
        }
    }
    const empty: ObservableContextMetric = Object.freeze({
        programObservable: programValues.length,
        baselineObservable: baselineValues.length,
        unknownProgram: total - programValues.length,
        unknownBaseline: total - baselineValues.length,
        pairs: 0,
        programMean: programValues.length > 0 ? meanOf(programValues) : null,
        baselineMean: baselineValues.length > 0 ? meanOf(baselineValues) : null,
        meanDelta: null,
        ci: null,
        cohensDz: null,
        unknown: true,
    });
    if (pairedValues.length === 0) {
        return empty;
    }
    const diffs = pairedValues.map((value) => value.programValue - value.baselineValue);
    return Object.freeze({
        ...empty,
        pairs: pairedValues.length,
        meanDelta: meanOf(diffs),
        ci: pairedMeanDeltaCI(diffs, {
            ...bootstrap,
            seed: analysisBootstrapSeed(bootstrap.seed, scope, key, 'context'),
        }),
        cohensDz: cohensDz(diffs),
        unknown: false,
    });
};

const taxonomyOf = (
    runs: readonly AgentEvalRun[],
): Readonly<Record<AgentEvalFailureCategory, number>> => countFailureTaxonomy(runs);

type ScenarioInput = Readonly<{
    scenarioId: string;
    scenarioName: string;
    trials: number;
    matched: readonly MatchedTrial[];
    unmatchedProgram: readonly UnmatchedTrial[];
    unmatchedBaseline: readonly UnmatchedTrial[];
    programRuns: readonly AgentEvalRun[];
    baselineRuns: readonly AgentEvalRun[];
}>;

const scenarioInputOf = (
    report: AgentEvalScenarioReport,
    trialSeeds: Readonly<Record<string, readonly number[] | undefined>>,
): ScenarioInput => {
    const {matched, unmatched} = pairScenarioRuns(report, trialSeeds);
    return Object.freeze({
        scenarioId: report.scenario.id,
        scenarioName: report.scenario.name,
        trials: report.scenario.trials,
        matched,
        unmatchedProgram: unmatched.filter((trial) => trial.mode === 'program'),
        unmatchedBaseline: unmatched.filter((trial) => trial.mode === 'react-baseline'),
        programRuns: report.runs.program ?? [],
        baselineRuns: report.runs['react-baseline'] ?? [],
    });
};

const buildAggregate = (
    input: ScenarioInput,
    scope: string,
    bootstrap: BootstrapOptions,
): AgentEvalAggregateAnalysis => {
    const taskSuccess = pairedBooleanDelta(
        input.matched,
        (run) => run.metrics.taskSuccess,
        (run) => run.metrics.taskSuccess,
        scope,
        'taskSuccess',
        bootstrap,
    );
    const recoverySuccess = pairedRecoveryDelta(input.matched, scope, bootstrap);
    const numeric = Object.fromEntries(
        AGENT_EVAL_ANALYSIS_METRICS.map((key) => [
            key,
            pairedNumericDelta(input.matched, key, scope, bootstrap),
        ]),
    ) as Readonly<Record<AgentEvalAnalysisMetricKey, PairedNumericDelta>>;
    const journal = Object.fromEntries(
        AGENT_EVAL_ANALYSIS_JOURNAL_METRICS.map((key) => [
            key,
            observableJournalMetric(input.matched, key, scope, bootstrap),
        ]),
    ) as Readonly<Record<AgentEvalAnalysisJournalMetricKey, ObservableJournalMetric>>;
    const context = Object.fromEntries(
        AGENT_EVAL_ANALYSIS_CONTEXT_METRICS.map((key) => [
            key,
            observableContextMetric(input.matched, key, scope, bootstrap),
        ]),
    ) as Readonly<Record<AgentEvalAnalysisContextMetricKey, ObservableContextMetric>>;
    const failureTaxonomy = {
        program: taxonomyOf(input.programRuns),
        'react-baseline': taxonomyOf(input.baselineRuns),
    } as Readonly<Record<AgentEvalMode, Readonly<Record<AgentEvalFailureCategory, number>>>>;
    return Object.freeze({
        matchedPairs: input.matched.length,
        taskSuccess,
        recoverySuccess,
        numeric,
        journal,
        context,
        failureTaxonomy,
        programRuns: input.programRuns.length,
        baselineRuns: input.baselineRuns.length,
    });
};

export const analyzeAgentEvalScenario = (
    report: AgentEvalScenarioReport,
    options: AgentEvalAnalysisOptions = {},
    trialSeeds: Readonly<Record<string, readonly number[] | undefined>> = {},
): AgentEvalScenarioAnalysis => {
    const bootstrap: BootstrapOptions = {
        seed: options.seed ?? 0,
        iterations: options.bootstrapIterations,
        level: options.bootstrapLevel,
    };
    const input = scenarioInputOf(report, trialSeeds);
    const aggregate = buildAggregate(input, report.scenario.id, bootstrap);
    return Object.freeze({
        ...aggregate,
        scenarioId: report.scenario.id,
        scenarioName: report.scenario.name,
        trials: report.scenario.trials,
        unmatchedProgram: Object.freeze([...input.unmatchedProgram]),
        unmatchedBaseline: Object.freeze([...input.unmatchedBaseline]),
    });
};

export const analyzeAgentEvalCorpus = (
    report: AgentEvalCorpusReport,
    options: AgentEvalAnalysisOptions = {},
): AgentEvalAnalysis => {
    const baseSeed = options.seed ?? report.corpus.seed;
    const bootstrap: BootstrapOptions = {
        seed: baseSeed,
        iterations: options.bootstrapIterations,
        level: options.bootstrapLevel,
    };
    const inputs = report.reports.map((scenarioReport) =>
        scenarioInputOf(scenarioReport, report.trialSeeds));
    const scenarios = inputs.map((input) => {
        const aggregate = buildAggregate(input, input.scenarioId, bootstrap);
        return Object.freeze({
            ...aggregate,
            scenarioId: input.scenarioId,
            scenarioName: input.scenarioName,
            trials: input.trials,
            unmatchedProgram: Object.freeze([...input.unmatchedProgram]),
            unmatchedBaseline: Object.freeze([...input.unmatchedBaseline]),
        });
    });
    const overallInput: ScenarioInput = Object.freeze({
        scenarioId: 'overall',
        scenarioName: 'Overall',
        trials: report.reports.reduce((acc, scenarioReport) => acc + scenarioReport.scenario.trials, 0),
        matched: inputs.flatMap((input) => input.matched),
        unmatchedProgram: inputs.flatMap((input) => input.unmatchedProgram),
        unmatchedBaseline: inputs.flatMap((input) => input.unmatchedBaseline),
        programRuns: report.reports.flatMap((scenarioReport) => scenarioReport.runs.program ?? []),
        baselineRuns: report.reports.flatMap(
            (scenarioReport) => scenarioReport.runs['react-baseline'] ?? [],
        ),
    });
    const overall = buildAggregate(overallInput, 'overall', bootstrap);
    return Object.freeze({
        version: AGENT_EVAL_ANALYSIS_VERSION,
        corpusId: report.corpus.id,
        seed: baseSeed,
        bootstrap: Object.freeze({
            iterations: options.bootstrapIterations ?? DEFAULT_BOOTSTRAP_ITERATIONS,
            level: options.bootstrapLevel ?? DEFAULT_BOOTSTRAP_LEVEL,
        }),
        pairing: Object.freeze({
            scenarios: report.reports.length,
            matchedPairs: overallInput.matched.length,
            unmatchedProgram: Object.freeze([...overallInput.unmatchedProgram]),
            unmatchedBaseline: Object.freeze([...overallInput.unmatchedBaseline]),
        }),
        scenarios: Object.freeze(scenarios),
        overall,
    });
};