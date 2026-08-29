import type {AgentEvalRun} from '../contracts';
import type {AgentEvalScenarioReport} from '../harness';
import type {AgentFaultEvent, AgentFaultKind} from '../faults/contracts';
import {AGENT_FAULT_KINDS} from '../faults/contracts';
import {analyzeFaultTrial, faultRecoverySuccess} from '../faults/semantics';
import type {AgentProgramEffectSummary} from '../../types';
import type {MatchedTrial, UnmatchedTrial} from './contracts';

/**
 * Strict trial pairing for the paired comparison. A pair only ever joins a
 * program run and a react-baseline run with the same scenario id AND the same
 * trial index (the seed index within the scenario). Unmatched trials are
 * surfaced explicitly and are never compared silently.
 */

export type FaultRecoveryEvidence = Readonly<{
    faultKind: AgentFaultKind;
    baseValues: Readonly<Record<string, string>>;
    events: readonly AgentFaultEvent[];
}>;

const readFaultRecoveryEvidence = (run: AgentEvalRun): FaultRecoveryEvidence | null => {
    const evidence = (run.verification.evidence ?? {}) as Partial<FaultRecoveryEvidence>;
    if (!evidence.faultKind
        || !evidence.baseValues
        || !Array.isArray(evidence.events)
        || !(AGENT_FAULT_KINDS as readonly string[]).includes(evidence.faultKind)) {
        return null;
    }
    return Object.freeze({
        faultKind: evidence.faultKind,
        baseValues: evidence.baseValues,
        events: evidence.events,
    });
};

const journalOf = (run: AgentEvalRun): readonly AgentProgramEffectSummary[] | null => {
    const programs = run.result.programs;
    if (!programs?.every((program) => program.effects !== undefined)) {
        return null;
    }
    return programs.flatMap((program) => program.effects ?? []);
};

/**
 * Recovery signal for one run. When the run carries committed fault-semantics
 * evidence (the external event log plus base values), recovery comes from the
 * external oracle which also attributes react-baseline recovery from public
 * event evidence. Otherwise the committed journal metric is used and `null`
 * stays unknown.
 */
export const recoveryOf = (run: AgentEvalRun): boolean | null => {
    const evidence = readFaultRecoveryEvidence(run);
    const journal = journalOf(run);
    if (evidence) {
        const summary = analyzeFaultTrial(evidence.events, evidence.baseValues, journal);
        return faultRecoverySuccess(evidence.faultKind, summary, journal !== null);
    }
    return run.metrics.recoverySuccess;
};

export type ScenarioPairing = Readonly<{
    matched: readonly MatchedTrial[];
    unmatched: readonly UnmatchedTrial[];
}>;

export const pairScenarioRuns = (
    report: AgentEvalScenarioReport,
    trialSeeds: Readonly<Record<string, readonly number[] | undefined>>,
): ScenarioPairing => {
    const programByTrial = new Map<number, AgentEvalRun>();
    const baselineByTrial = new Map<number, AgentEvalRun>();
    for (const run of report.runs.program ?? []) {
        programByTrial.set(run.trialIndex, run);
    }
    for (const run of report.runs['react-baseline'] ?? []) {
        baselineByTrial.set(run.trialIndex, run);
    }
    const trialIndices = [...new Set([...programByTrial.keys(), ...baselineByTrial.keys()])]
        .sort((a, b) => a - b);
    const seeds = trialSeeds[report.scenario.id];
    const seedOf = (trialIndex: number): number | null => seeds?.[trialIndex] ?? null;
    const matched: MatchedTrial[] = [];
    const unmatched: UnmatchedTrial[] = [];
    for (const trialIndex of trialIndices) {
        const program = programByTrial.get(trialIndex);
        const baseline = baselineByTrial.get(trialIndex);
        if (program !== undefined && baseline !== undefined) {
            matched.push(Object.freeze({
                scenarioId: report.scenario.id,
                trialIndex,
                seed: seedOf(trialIndex),
                program,
                baseline,
            }));
        } else if (program !== undefined) {
            unmatched.push(Object.freeze({
                scenarioId: report.scenario.id,
                trialIndex,
                seed: seedOf(trialIndex),
                mode: 'program' as const,
            }));
        } else if (baseline !== undefined) {
            unmatched.push(Object.freeze({
                scenarioId: report.scenario.id,
                trialIndex,
                seed: seedOf(trialIndex),
                mode: 'react-baseline' as const,
            }));
        }
    }
    return Object.freeze({
        matched: Object.freeze(matched),
        unmatched: Object.freeze(unmatched),
    });
};