import type {AgentEvalMode, AgentEvalRun} from '../contracts';

/**
 * Paired statistical analysis of a Program-first vs react-baseline corpus
 * report. Every statistic is derived from committed AgentEvalCorpusReport /
 * scenario reports only: no model or browser calls happen here, and the
 * analysis is pure and read-only.
 */

export const AGENT_EVAL_ANALYSIS_VERSION = 1 as const;
export type AgentEvalAnalysisVersion = typeof AGENT_EVAL_ANALYSIS_VERSION;

export const AGENT_EVAL_ANALYSIS_METRICS = [
    'turns',
    'toolCalls',
    'readCalls',
    'controlCalls',
    'effectCalls',
    'postErrorEffectCalls',
    'durationMs',
] as const;
export type AgentEvalAnalysisMetricKey = (typeof AGENT_EVAL_ANALYSIS_METRICS)[number];

export const AGENT_EVAL_ANALYSIS_JOURNAL_METRICS = [
    'failedWorldChangingEffects',
    'compensationEffects',
    'worldEffectCalls',
] as const;
export type AgentEvalAnalysisJournalMetricKey = (typeof AGENT_EVAL_ANALYSIS_JOURNAL_METRICS)[number];

export const AGENT_EVAL_FAILURE_CATEGORIES = [
    'planning',
    'read-resolve',
    'mutation',
    'recovery',
    'governance',
    'verification',
    'unknown',
] as const;
export type AgentEvalFailureCategory = (typeof AGENT_EVAL_FAILURE_CATEGORIES)[number];

export type ConfidenceInterval = Readonly<{
    level: number;
    iterations: number;
    seed: number;
    lower: number;
    upper: number;
}>;

export type UnmatchedTrial = Readonly<{
    scenarioId: string;
    trialIndex: number;
    seed: number | null;
    mode: AgentEvalMode;
}>;

export type MatchedTrial = Readonly<{
    scenarioId: string;
    trialIndex: number;
    seed: number | null;
    program: AgentEvalRun;
    baseline: AgentEvalRun;
}>;

export type PairedNumericDelta = Readonly<{
    pairs: number;
    programMean: number | null;
    baselineMean: number | null;
    /** program - baseline, over matched pairs. */
    meanDelta: number | null;
    ci: ConfidenceInterval | null;
    cohensDz: number | null;
}>;

export type PairedBooleanDelta = Readonly<{
    pairs: number;
    programRate: number | null;
    baselineRate: number | null;
    delta: number | null;
    win: number;
    loss: number;
    tie: number;
    ci: ConfidenceInterval | null;
    cohensH: number | null;
}>;

export type PairedRecoveryDelta = Readonly<{
    pairs: number;
    knownPairs: number;
    programKnown: number;
    baselineKnown: number;
    unknownProgram: number;
    unknownBaseline: number;
    programRate: number | null;
    baselineRate: number | null;
    delta: number | null;
    win: number;
    loss: number;
    tie: number;
    ci: ConfidenceInterval | null;
    cohensH: number | null;
}>;

/**
 * Journal-only metrics that one mode may not observe. `programMean` /
 * `baselineMean` average only the runs where the value is observable, and the
 * paired `meanDelta` exists only when both modes are observable in the same
 * pair. Unknown is explicit, never silently reported as zero.
 */
export type ObservableJournalMetric = Readonly<{
    programObservable: number;
    baselineObservable: number;
    pairs: number;
    programMean: number | null;
    baselineMean: number | null;
    meanDelta: number | null;
    ci: ConfidenceInterval | null;
    unknown: boolean;
}>;

export type AgentEvalAggregateAnalysis = Readonly<{
    matchedPairs: number;
    taskSuccess: PairedBooleanDelta;
    recoverySuccess: PairedRecoveryDelta;
    numeric: Readonly<Record<AgentEvalAnalysisMetricKey, PairedNumericDelta>>;
    journal: Readonly<Record<AgentEvalAnalysisJournalMetricKey, ObservableJournalMetric>>;
    failureTaxonomy: Readonly<Record<AgentEvalMode, Readonly<Record<AgentEvalFailureCategory, number>>>>;
    programRuns: number;
    baselineRuns: number;
}>;

export type AgentEvalScenarioAnalysis = Readonly<
    AgentEvalAggregateAnalysis & {
        scenarioId: string;
        scenarioName: string;
        trials: number;
        unmatchedProgram: readonly UnmatchedTrial[];
        unmatchedBaseline: readonly UnmatchedTrial[];
    }
>;

export type AgentEvalAnalysisOptions = Readonly<{
    bootstrapIterations?: number;
    bootstrapLevel?: number;
    seed?: number;
}>;

export type AgentEvalAnalysisPairing = Readonly<{
    scenarios: number;
    matchedPairs: number;
    unmatchedProgram: readonly UnmatchedTrial[];
    unmatchedBaseline: readonly UnmatchedTrial[];
}>;

export type AgentEvalAnalysis = Readonly<{
    version: AgentEvalAnalysisVersion;
    corpusId: string;
    seed: number;
    bootstrap: Readonly<{
        iterations: number;
        level: number;
    }>;
    pairing: AgentEvalAnalysisPairing;
    scenarios: readonly AgentEvalScenarioAnalysis[];
    overall: AgentEvalAggregateAnalysis;
}>;