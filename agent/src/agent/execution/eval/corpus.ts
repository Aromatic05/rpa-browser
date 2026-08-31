import type {AgentEvalMode, AgentEvalRun, AgentEvalScenario} from './contracts';
import type {AgentRunner} from '../types';
import type {AgentEvalModeAggregate} from './aggregate';
import {computeAgentEvalAggregates} from './aggregate';
import {filterScenarios} from './scenario';
import {runAgentEvalScenario} from './harness';
import type {AgentEvalScenarioReport} from './harness';
import {toAgentEvalJsonReport} from './report';
import {allModesPassed} from './report';
import {DEFAULT_AGENT_EVAL_SEED, deriveTrialSeed} from './seed';

export const AGENT_EVAL_CORPUS_REPORT_VERSION = 1 as const;
export type AgentEvalCorpusReportVersion = typeof AGENT_EVAL_CORPUS_REPORT_VERSION;

export type AgentEvalCorpusEntry = Readonly<{
    scenario: AgentEvalScenario;
    runner: AgentRunner;
}>;

/**
 * A benchmark corpus: one executable program-first vs react-baseline suite.
 * Entries pair a versioned scenario with the runner that executes it, so a
 * corpus can mix fixture worlds, browser pages and live Workspace Agents.
 */
export type AgentEvalCorpus = Readonly<{
    id: string;
    version: number;
    description?: string;
    entries: readonly AgentEvalCorpusEntry[];
}>;

export type RunAgentEvalCorpusOptions = Readonly<{
    scenarioQuery?: string;
    modes?: readonly AgentEvalMode[];
    trials?: number;
    seed?: number;
    onScenarioReport?: (report: AgentEvalScenarioReport) => void | Promise<void>;
}>;

export type AgentEvalCorpusModelRef = Readonly<{
    provider: string;
    model: string;
    scenarioIds: readonly string[];
}>;

export type AgentEvalCorpusMetadata = Readonly<{
    id: string;
    version: number;
    description?: string;
    seed: number;
    scenarioIds: readonly string[];
    modes: readonly AgentEvalMode[];
    trialsOverride: number | null;
    models: readonly AgentEvalCorpusModelRef[];
}>;

export type AgentEvalCorpusReport = Readonly<{
    version: AgentEvalCorpusReportVersion;
    generatedAt: string;
    corpus: AgentEvalCorpusMetadata;
    trialSeeds: Readonly<Record<string, readonly number[]>>;
    reports: readonly AgentEvalScenarioReport[];
    aggregates: Readonly<Partial<Record<AgentEvalMode, AgentEvalModeAggregate>>>;
}>;

const collectModels = (
    scenarios: readonly AgentEvalScenario[],
): AgentEvalCorpusModelRef[] => {
    const byModel = new Map<string, AgentEvalCorpusModelRef>();
    for (const scenario of scenarios) {
        const key = `${scenario.task.provider}/${scenario.task.model}`;
        const existing = byModel.get(key);
        if (existing) {
            byModel.set(key, {...existing, scenarioIds: [...existing.scenarioIds, scenario.id]});
        } else {
            byModel.set(key, {
                provider: scenario.task.provider,
                model: scenario.task.model,
                scenarioIds: [scenario.id],
            });
        }
    }
    return [...byModel.values()];
};

const buildCorpusMetadata = (
    corpus: AgentEvalCorpus,
    scenarios: readonly AgentEvalScenario[],
    options: RunAgentEvalCorpusOptions,
): AgentEvalCorpusMetadata => {
    const modes = new Set<AgentEvalMode>();
    for (const scenario of scenarios) {
        for (const mode of scenario.modes) {
            modes.add(mode);
        }
    }
    return Object.freeze({
        id: corpus.id,
        version: corpus.version,
        description: corpus.description,
        seed: options.seed ?? DEFAULT_AGENT_EVAL_SEED,
        scenarioIds: Object.freeze(scenarios.map((scenario) => scenario.id)),
        modes: Object.freeze([...modes]),
        trialsOverride: options.trials ?? null,
        models: Object.freeze(collectModels(scenarios)),
    });
};

/**
 * Execute a corpus sequentially so trials against a shared browser or workspace
 * never interleave. Returns per-scenario reports plus corpus-wide per-mode
 * aggregates for the program-first vs react-baseline comparison.
 */
export const runAgentEvalCorpus = async (
    corpus: AgentEvalCorpus,
    options: RunAgentEvalCorpusOptions = {},
): Promise<AgentEvalCorpusReport> => {
    const seed = options.seed ?? DEFAULT_AGENT_EVAL_SEED;
    const scenarioIndex = new Map(corpus.entries.map((entry) => [entry.scenario.id, entry]));
    const selected = filterScenarios(corpus.entries.map((entry) => entry.scenario), {
        query: options.scenarioQuery,
        modes: options.modes,
    });
    const reports: AgentEvalScenarioReport[] = [];
    const trialSeeds: Record<string, readonly number[]> = {};
    const allRuns: Partial<Record<AgentEvalMode, AgentEvalRun[]>> = {};

    for (const scenario of selected) {
        const entry = scenarioIndex.get(scenario.id);
        if (!entry) {
            throw new Error(`Corpus entry missing for scenario ${scenario.id}`);
        }
        const effective: AgentEvalScenario = {
            ...scenario,
            trials: Math.max(1, options.trials ?? scenario.trials),
        };
        trialSeeds[scenario.id] = Object.freeze(
            Array.from({length: effective.trials}, (_unused, trialIndex) =>
                deriveTrialSeed(seed, scenario.id, trialIndex)),
        );
        const report = await runAgentEvalScenario({runner: entry.runner, modes: effective.modes}, effective);
        reports.push(report);
        await options.onScenarioReport?.(report);
        for (const [mode, modeRuns] of Object.entries(report.runs) as [AgentEvalMode, AgentEvalRun[]][]) {
            (allRuns[mode] ??= []).push(...modeRuns);
        }
    }

    return Object.freeze({
        version: AGENT_EVAL_CORPUS_REPORT_VERSION,
        generatedAt: new Date().toISOString(),
        corpus: buildCorpusMetadata(corpus, selected, options),
        trialSeeds: Object.freeze(trialSeeds),
        reports: Object.freeze(reports),
        aggregates: computeAgentEvalAggregates(allRuns),
    });
};

const STABLE_OMITTED_KEYS: ReadonlySet<string> = new Set(['generatedAt', 'durationMs']);

/**
 * Keys omitted from the deterministic serialization: `generatedAt` is a wall
 * clock stamp and `durationMs` is measured latency. Both remain available in
 * the in-memory report and in non-deterministic JSON output.
 */

const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => stableValue(item));
    }
    if (value && typeof value === 'object') {
        const source = value as Record<string, unknown>;
        const result: Record<string, unknown> = {};
        for (const key of Object.keys(source).sort()) {
            if (STABLE_OMITTED_KEYS.has(key)) {
                continue;
            }
            result[key] = stableValue(source[key]);
        }
        return result;
    }
    return value;
};

/**
 * Deterministic JSON: keys sorted, volatile timestamps removed. Two runs of a
 * deterministic corpus with the same seed serialize byte-identically.
 */
export const serializeAgentEvalCorpusReport = (value: unknown, space = 2): string =>
    JSON.stringify(stableValue(value), null, space);

export const toAgentEvalCorpusJson = (
    report: AgentEvalCorpusReport,
    options: Readonly<{space?: number; deterministic?: boolean; includeRawResults?: boolean}> = {},
): string => {
    const payload = {
        version: report.version,
        corpus: report.corpus,
        trialSeeds: report.trialSeeds,
        reports: report.reports.map((scenarioReport) => toAgentEvalJsonReport(scenarioReport, options)),
        aggregates: report.aggregates,
    };
    if (options.deterministic === false) {
        return JSON.stringify({...payload, generatedAt: report.generatedAt}, null, options.space ?? 2);
    }
    return serializeAgentEvalCorpusReport(payload, options.space ?? 2);
};

export const writeAgentEvalCorpusReport = async (
    report: AgentEvalCorpusReport,
    path: string,
    options?: Readonly<{space?: number; deterministic?: boolean; includeRawResults?: boolean}>,
): Promise<void> => {
    const {writeFile} = await import('node:fs/promises');
    await writeFile(path, toAgentEvalCorpusJson(report, options), 'utf8');
};

/**
 * Process exit code for a corpus run: 0 only when every executed scenario
 * passed in every executed mode.
 */
export const agentEvalCorpusExitCode = (report: AgentEvalCorpusReport): number => {
    const passed = report.reports.length > 0
        && report.reports.every((scenarioReport) => allModesPassed(scenarioReport));
    return passed ? 0 : 1;
};
