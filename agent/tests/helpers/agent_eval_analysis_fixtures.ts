import type {AgentEvalMode, AgentEvalMetrics, AgentEvalRun} from '../../src/agent/execution/eval/contracts';
import type {AgentEvalCorpusReport} from '../../src/agent/execution/eval/corpus';
import {runAgentEvalCorpus} from '../../src/agent/execution/eval/corpus';
import type {AgentEvalScenarioReport} from '../../src/agent/execution/eval/harness';
import {deriveTrialSeed} from '../../src/agent/execution/eval/seed';
import type {
    AgentProgramEffectSummary,
    AgentRunResult,
} from '../../src/agent/execution/types';
import type {AgentToolTrace} from '../../src/agent/trace/collector';
import {createAgentFaultCorpus} from './agent_fault_entries';

/**
 * Fixtures for the paired analysis integration tests. Everything is in-memory
 * and deterministic; no model or browser is ever contacted.
 */

export type AgentEvalAnalysisToolSpec = Readonly<{
    toolName: string;
    classification: 'read' | 'control' | 'effect';
    isError?: boolean;
}>;

export type AgentEvalAnalysisEffectSpec = Readonly<{
    status: 'succeeded' | 'failed';
    compensates?: number;
    stepName?: string;
}>;

export type AgentEvalAnalysisRunSpec = Readonly<{
    mode: AgentEvalMode;
    trialIndex: number;
    taskSuccess?: boolean;
    recoverySuccess?: boolean | null;
    verificationPassed?: boolean;
    turns?: number;
    toolCalls?: number;
    readCalls?: number;
    controlCalls?: number;
    effectCalls?: number;
    postErrorEffectCalls?: number;
    failedToolCalls?: number;
    durationMs?: number;
    failedWorldChangingEffects?: number | null;
    compensationEffects?: number | null;
    worldEffectCalls?: number | null;
    tools?: readonly AgentEvalAnalysisToolSpec[];
    programStatus?: 'completed' | 'failed' | 'aborted' | 'invalid';
    journalEffects?: readonly AgentEvalAnalysisEffectSpec[];
}>;

export const agent_eval_analysis_makeRun = (spec: AgentEvalAnalysisRunSpec): AgentEvalRun => {
    const mode = spec.mode;
    const tools: AgentToolTrace[] = (spec.tools ?? []).map((tool, index) => Object.freeze({
        toolCallId: `analysis-tool-${index}`,
        toolName: tool.toolName,
        classification: tool.classification,
        args: {},
        startedAt: index,
        ...(tool.isError === true ? {isError: true} : {}),
    }));
    const journalEffects = spec.journalEffects ?? [];
    const programEffects: AgentProgramEffectSummary[] = journalEffects.map((effect, index) => Object.freeze({
        sequence: index + 1,
        stepName: effect.stepName ?? 'browser.fill',
        status: effect.status,
        worldBefore: {pageEpoch: 'epoch-1', captureRevision: 1},
        worldAfter: {pageEpoch: 'epoch-1', captureRevision: 2},
        ...(effect.compensates === undefined ? {} : {compensates: effect.compensates}),
    }));
    const taskSuccess = spec.taskSuccess ?? true;
    const metrics: AgentEvalMetrics = Object.freeze({
        turns: spec.turns ?? 1,
        toolCalls: spec.toolCalls ?? tools.length,
        readCalls: spec.readCalls ?? 0,
        controlCalls: spec.controlCalls ?? 0,
        effectCalls: spec.effectCalls ?? 0,
        failedToolCalls: spec.failedToolCalls ?? 0,
        postErrorEffectCalls: spec.postErrorEffectCalls ?? 0,
        taskSuccess,
        recoverySuccess: spec.recoverySuccess === undefined
            ? (mode === 'program' ? true : null)
            : spec.recoverySuccess,
        durationMs: spec.durationMs ?? 100,
        effects: Object.freeze({
            toolEffectCalls: spec.effectCalls ?? 0,
            worldEffectCalls: spec.worldEffectCalls === undefined
                ? (mode === 'program' ? 1 : null)
                : spec.worldEffectCalls,
            failedWorldChangingEffects: spec.failedWorldChangingEffects === undefined
                ? (mode === 'program' ? 0 : null)
                : spec.failedWorldChangingEffects,
            compensationEffects: spec.compensationEffects === undefined
                ? (mode === 'program' ? 0 : null)
                : spec.compensationEffects,
            availability: mode === 'program' ? 'program-journal' : 'not-exposed',
        }),
        repair: Object.freeze({
            rewindCalls: 0,
            rollbackCalls: 0,
            patchCalls: 0,
            recomputeCalls: 0,
            refreshCalls: 0,
        }),
    });
    const programStatus = spec.programStatus ?? 'completed';
    const result: AgentRunResult = Object.freeze({
        provider: 'agent-eval-analysis-fixture',
        model: 'deterministic',
        text: `simulated-${mode}`,
        executionMode: mode,
        trace: Object.freeze({
            metrics: Object.freeze({
                turns: metrics.turns,
                toolCalls: metrics.toolCalls,
                readCalls: metrics.readCalls,
                controlCalls: metrics.controlCalls,
                effectCalls: metrics.effectCalls,
                failedToolCalls: metrics.failedToolCalls,
                postErrorEffectCalls: metrics.postErrorEffectCalls,
            }),
            tools: [...tools],
        }),
        ...(mode === 'program'
            ? {
                programs: Object.freeze([Object.freeze({
                    source: 'agent-eval-analysis-program',
                    input: {},
                    status: programStatus,
                    effects: Object.freeze([...programEffects]),
                })]),
            }
            : {}),
    });
    return Object.freeze({
        taskId: `task-${spec.mode}-${spec.trialIndex}`,
        mode,
        trialIndex: spec.trialIndex,
        success: taskSuccess,
        durationMs: metrics.durationMs,
        verification: Object.freeze({
            passed: spec.verificationPassed ?? taskSuccess,
        }),
        metrics,
        result,
    });
};

export type AgentEvalAnalysisScenarioSpec = Readonly<{
    scenarioId: string;
    scenarioName?: string;
    trials?: number;
    runs: readonly AgentEvalRun[];
}>;

export const agent_eval_analysis_makeScenarioReport = (
    spec: AgentEvalAnalysisScenarioSpec,
): AgentEvalScenarioReport => {
    const runsByMode: Partial<Record<AgentEvalMode, AgentEvalRun[]>> = {};
    for (const run of spec.runs) {
        (runsByMode[run.mode] ??= []).push(run);
    }
    const modes = Object.keys(runsByMode) as AgentEvalMode[];
    const frozenRuns: Partial<Record<AgentEvalMode, readonly AgentEvalRun[]>> = {};
    for (const mode of modes) {
        frozenRuns[mode] = Object.freeze([...(runsByMode[mode] ?? [])]);
    }
    return Object.freeze({
        version: 1,
        generatedAt: 'analysis-fixture',
        scenario: Object.freeze({
            id: spec.scenarioId,
            name: spec.scenarioName ?? spec.scenarioId,
            modes: Object.freeze(modes),
            trials: spec.trials ?? spec.runs.length,
            contractVersion: 1,
        }),
        runs: Object.freeze(frozenRuns),
        aggregates: Object.freeze({}),
    });
};

export type AgentEvalAnalysisCorpusSpec = Readonly<{
    corpusId?: string;
    seed?: number;
    scenarios: readonly AgentEvalScenarioReport[];
}>;

export const agent_eval_analysis_makeCorpusReport = (
    spec: AgentEvalAnalysisCorpusSpec,
): AgentEvalCorpusReport => {
    const seed = spec.seed ?? 0;
    const trialSeeds: Record<string, readonly number[]> = {};
    for (const scenarioReport of spec.scenarios) {
        const programTrials = scenarioReport.runs.program?.map((run) => run.trialIndex) ?? [];
        const baselineTrials = scenarioReport.runs['react-baseline']?.map((run) => run.trialIndex) ?? [];
        const maxTrial = Math.max(-1, ...programTrials, ...baselineTrials);
        trialSeeds[scenarioReport.scenario.id] = Object.freeze(
            Array.from({length: maxTrial + 1}, (_unused, trialIndex) =>
                deriveTrialSeed(seed, scenarioReport.scenario.id, trialIndex)),
        );
    }
    return Object.freeze({
        version: 1,
        generatedAt: 'analysis-fixture',
        corpus: Object.freeze({
            id: spec.corpusId ?? 'analysis-fixture-corpus',
            version: 1,
            seed,
            scenarioIds: Object.freeze(spec.scenarios.map((scenarioReport) => scenarioReport.scenario.id)),
            modes: Object.freeze(['program', 'react-baseline'] as const),
            trialsOverride: null,
            models: Object.freeze([]),
        }),
        trialSeeds: Object.freeze(trialSeeds),
        reports: Object.freeze([...spec.scenarios]),
        aggregates: Object.freeze({}),
    });
};

export const AGENT_EVAL_ANALYSIS_FAULT_SEED = 90210;
export const AGENT_EVAL_ANALYSIS_FAULT_TRIALS = 2;

/**
 * The committed fault semantic-oracle corpus: every fault kind x every mode,
 * judged by the external event log and the program-mode effect journal. Used
 * as a fixture to prove react-baseline journal metrics stay unknown while the
 * external recovery oracle still attributes recovery from public evidence.
 */
export const agent_eval_analysis_faultCorpusReport = async (): Promise<AgentEvalCorpusReport> =>
    runAgentEvalCorpus(
        createAgentFaultCorpus({
            backend: 'fixture',
            seed: AGENT_EVAL_ANALYSIS_FAULT_SEED,
            trials: AGENT_EVAL_ANALYSIS_FAULT_TRIALS,
        }),
        {seed: AGENT_EVAL_ANALYSIS_FAULT_SEED},
    );