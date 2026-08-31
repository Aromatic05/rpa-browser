import type {AgentEvalMode, AgentEvalRun} from '../contracts';
import type {AgentEvalScenarioReport} from '../harness';
import {serializeAgentEvalCorpusReport} from '../corpus';
import type {AgentFaultEvent, AgentFaultKind} from './contracts';
import {AGENT_FAULT_SCENARIO_ID_PREFIX} from './scenarios';
import {analyzeFaultTrial, faultRecoverySuccess} from './semantics';

/**
 * Fault-kind x execution-mode matrix for paper experiments. Every cell is
 * derived from external evidence only: the verifier's event log (carried in
 * run.verification.evidence) and the program-mode effect journal (carried in
 * run.result.programs). Journal-invisible quantities stay literally unknown
 * for react-baseline instead of being silently reported as zero.
 */

const FAULT_MODES: readonly AgentEvalMode[] = ['program', 'react-baseline'];

export type AgentFaultMatrixCell = Readonly<{
    faultKind: AgentFaultKind;
    mode: AgentEvalMode;
    trials: number;
    taskSuccessRate: number;
    /** Recovery per the external fault semantics, not the journal heuristic. */
    faultRecoveryRate: number;
    /** Recovery per the committed journal-only metric; unknown for baseline. */
    journalRecovery: 'unknown' | {passed: number; count: number};
    journalAvailability: 'program-journal' | 'not-exposed';
    failedWorldChangingEffects: number | 'unknown';
    transactionalCompensations: number | 'unknown';
    adHocRestores: number;
    redundantAppliedEffects: number;
    postRewindReplayEffects: number;
    conflictsDetected: number;
    externalMutations: number;
    toolEffectCalls: number;
    postErrorEffectCalls: number;
    unknownMetricCount: number;
}>;

type FaultEvidence = Readonly<{
    faultKind: AgentFaultKind;
    baseValues: Readonly<Record<string, string>>;
    events: readonly AgentFaultEvent[];
}>;

const readEvidence = (run: AgentEvalRun): FaultEvidence | null => {
    const {events, faultKind, baseValues} = (run.verification.evidence ?? {}) as Partial<FaultEvidence>;
    if (!Array.isArray(events) || !faultKind || !baseValues) {
        return null;
    }
    return {faultKind, baseValues, events};
};

const journalOf = (run: AgentEvalRun) => {
    const programs = run.result.programs;
    if (!programs?.every((program) => program.effects !== undefined)) {
        return null;
    }
    return programs.flatMap((program) => program.effects ?? []);
};

const cellFor = (
    faultKind: AgentFaultKind,
    mode: AgentEvalMode,
    runs: readonly AgentEvalRun[],
): AgentFaultMatrixCell => {
    let adHoc = 0;
    let redundant = 0;
    let replay = 0;
    let conflicts = 0;
    let external = 0;
    let faultRecovered = 0;
    let journalPassed = 0;
    let journalCount = 0;
    let journalVisible = true;
    let failedWorldChangingSum = 0;
    let transactionalSum = 0;

    for (const run of runs) {
        const evidence = readEvidence(run);
        if (!evidence) {
            throw new Error(`run ${run.taskId}/${run.mode}#${run.trialIndex} carries no fault evidence`);
        }
        const journal = journalOf(run);
        const summary = analyzeFaultTrial(evidence.events, evidence.baseValues, journal);
        adHoc += summary.adHocRestores;
        redundant += summary.redundantAppliedEffects;
        replay += summary.postRewindReplayEffects;
        conflicts += summary.conflictsDetected;
        external += summary.externalMutations;
        if (faultRecoverySuccess(evidence.faultKind, summary, journal !== null)) {
            faultRecovered += 1;
        }
        if (run.metrics.recoverySuccess !== null) {
            journalCount += 1;
            if (run.metrics.recoverySuccess) {
                journalPassed += 1;
            }
        }
        if (run.metrics.effects.availability === 'program-journal') {
            failedWorldChangingSum += run.metrics.effects.failedWorldChangingEffects ?? 0;
            transactionalSum += run.metrics.effects.compensationEffects ?? 0;
        } else {
            journalVisible = false;
        }
    }

    const unknownMetricCount = runs.length * (mode === 'program'
        ? 0
        : 4 /* worldEffectCalls, failedWorldChangingEffects, compensationEffects, recoverySuccess */);

    return Object.freeze({
        faultKind,
        mode,
        trials: runs.length,
        taskSuccessRate: runs.length === 0 ? 0 : runs.filter((run) => run.success).length / runs.length,
        faultRecoveryRate: runs.length === 0 ? 0 : faultRecovered / runs.length,
        journalRecovery: journalCount === 0 ? 'unknown' : Object.freeze({passed: journalPassed, count: journalCount}),
        journalAvailability: mode === 'program' ? 'program-journal' : 'not-exposed',
        failedWorldChangingEffects: journalVisible ? failedWorldChangingSum : 'unknown',
        transactionalCompensations: journalVisible ? transactionalSum : 'unknown',
        adHocRestores: adHoc,
        redundantAppliedEffects: redundant,
        postRewindReplayEffects: replay,
        conflictsDetected: conflicts,
        externalMutations: external,
        toolEffectCalls: runs.reduce((acc, run) => acc + run.metrics.effects.toolEffectCalls, 0),
        postErrorEffectCalls: runs.reduce((acc, run) => acc + run.metrics.postErrorEffectCalls, 0),
        unknownMetricCount,
    });
};

export type AgentFaultMatrixReport = Readonly<{
    version: 1;
    cells: readonly AgentFaultMatrixCell[];
}>;

const kindOfScenarioId = (scenarioId: string): AgentFaultKind | null =>
    scenarioId.startsWith(AGENT_FAULT_SCENARIO_ID_PREFIX)
        ? scenarioId.slice(AGENT_FAULT_SCENARIO_ID_PREFIX.length) as AgentFaultKind
        : null;

/**
 * Build the matrix from scenario reports produced by the committed harness.
 * Cells are ordered by the canonical fault-kind list, program first per kind.
 */
export const buildAgentFaultMatrix = (
    reports: readonly AgentEvalScenarioReport[],
): AgentFaultMatrixReport => {
    const cells: AgentFaultMatrixCell[] = [];
    for (const report of reports) {
        const kind = kindOfScenarioId(report.scenario.id);
        if (!kind) {
            continue;
        }
        for (const mode of FAULT_MODES) {
            const runs = report.runs[mode];
            if (runs && runs.length > 0) {
                cells.push(cellFor(kind, mode, runs));
            }
        }
    }
    return Object.freeze({
        version: 1 as const,
        cells: Object.freeze(cells),
    });
};

export const faultMatrixToJson = (matrix: AgentFaultMatrixReport, space = 2): string =>
    serializeAgentEvalCorpusReport(matrix, space);

const cellValue = (value: number | 'unknown'): string => value === 'unknown' ? 'unknown' : String(value);

/** Markdown rendering; journal-invisible baseline cells read `unknown`. */
export const faultMatrixToMarkdown = (matrix: AgentFaultMatrixReport): string => {
    const header = '| fault | mode | trials | task | recovery | failedWorld | compensations | adHocRestores | redundant | postRewindReplay | conflicts | postErrorEffects |';
    const divider = '|---|---|---|---|---|---|---|---|---|---|---|---|';
    const rows = matrix.cells.map((cell) => [
        cell.faultKind,
        cell.mode,
        String(cell.trials),
        cell.taskSuccessRate.toFixed(2),
        cell.faultRecoveryRate.toFixed(2),
        cellValue(cell.failedWorldChangingEffects),
        cellValue(cell.transactionalCompensations),
        String(cell.adHocRestores),
        String(cell.redundantAppliedEffects),
        String(cell.postRewindReplayEffects),
        String(cell.conflictsDetected),
        String(cell.postErrorEffectCalls),
    ].join(' | '));
    return [`# agent fault matrix`, header, divider, ...rows.map((row) => `| ${row} |`)].join('\n');
};
