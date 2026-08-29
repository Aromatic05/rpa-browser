import type {AgentProgramEffectSummary} from '../../types';
import {AGENT_FAULT_ERROR_CODES} from './contracts';
import type {AgentFaultEvent, AgentFaultKind} from './contracts';

/**
 * External transactional-semantics analysis over the fault world's event log
 * plus the program-mode effect journal. These helpers are the measurement
 * instruments of the study: they attribute every world change to either a
 * retained-transaction compensation (journal-linked) or an ad-hoc re-issue
 * (event-only), and they flag redundant writes that a verified WorldView
 * should make impossible.
 */

const isFailedAfterApply = (event: AgentFaultEvent): boolean =>
    event.kind === 'fill-failed-after-apply'
        && event.reason !== AGENT_FAULT_ERROR_CODES.partialRestore;

const isAnyWriteFailure = (event: AgentFaultEvent): boolean =>
    event.kind === 'fill-failed-after-apply' || event.kind === 'fill-failed-no-effect';

export type AgentFaultSemanticsSummary = Readonly<{
    appliedEffects: number;
    rejectedEffects: number;
    /** Agent-caused world changes that were reported as failures. */
    failedAfterApplyByAgent: number;
    externalMutations: number;
    conflictsDetected: number;
    navigations: number;
    drifts: number;
    /** Writes that re-applied a value the world already verifiably held. */
    redundantAppliedEffects: number;
    /** Redundant re-applies issued after a rewind event (drift/navigation). */
    postRewindReplayEffects: number;
    /** Ad-hoc restore writes (baseline-style recovery to a pre-fault value). */
    adHocRestores: number;
    /** Journal sequences whose success is proven by an applied fill event. */
    journaledCompensations: number;
}>;

const compensationRevisions = (journal: readonly AgentProgramEffectSummary[] | null): Set<number> => {
    const revisions = new Set<number>();
    if (!journal) {
        return revisions;
    }
    for (const effect of journal) {
        if (effect.compensates !== undefined) {
            revisions.add(effect.worldAfter.captureRevision);
        }
    }
    return revisions;
};

/**
 * Analyze one trial. `journal` is the program-mode effect journal when the
 * mode exposes one, otherwise `null` (react-baseline has no journal, so
 * transactional attribution is impossible by construction).
 */
export const analyzeFaultTrial = (
    events: readonly AgentFaultEvent[],
    baseValues: Readonly<Record<string, string>>,
    journal: readonly AgentProgramEffectSummary[] | null,
): AgentFaultSemanticsSummary => {
    const known = new Map<string, string>();
    let sawRewind = false;
    let redundant = 0;
    let postRewindReplay = 0;
    let adHocRestores = 0;
    let applied = 0;
    let rejected = 0;
    let failedAfterApply = 0;
    let external = 0;
    let conflicts = 0;
    let navigations = 0;
    let drifts = 0;
    const linkedRevisions = compensationRevisions(journal);

    for (const event of events) {
        switch (event.kind) {
            case 'load': {
                for (const [key, value] of Object.entries(baseValues)) {
                    known.set(key, value);
                }
                sawRewind = false;
                break;
            }
            case 'read': {
                known.set(event.key, event.value ?? '');
                break;
            }
            case 'external-mutate': {
                external += 1;
                known.set(event.key, event.value ?? '');
                break;
            }
            case 'drift': {
                drifts += 1;
                sawRewind = true;
                known.set(event.key, '');
                break;
            }
            case 'navigation': {
                navigations += 1;
                sawRewind = true;
                for (const [key, value] of Object.entries(baseValues)) {
                    known.set(key, value);
                }
                break;
            }
            case 'fill-rejected': {
                rejected += 1;
                if (event.reason === AGENT_FAULT_ERROR_CODES.revisionConflict) {
                    conflicts += 1;
                }
                break;
            }
            case 'click-rejected': {
                rejected += 1;
                break;
            }
            case 'fill-failed-after-apply': {
                if (isFailedAfterApply(event)) {
                    failedAfterApply += 1;
                }
                known.set(event.key, event.value ?? '');
                break;
            }
            case 'fill-failed-no-effect': {
                break;
            }
            case 'rebind': {
                break;
            }
            case 'click-applied': {
                applied += 1;
                break;
            }
            case 'fill-applied': {
                applied += 1;
                const value = event.value ?? '';
                const worldAlreadyHeldValue = known.get(event.key) === value;
                if (worldAlreadyHeldValue) {
                    redundant += 1;
                    if (sawRewind) {
                        postRewindReplay += 1;
                    }
                }
                const restoreSignature = value === baseValues[event.key]
                    && events.some((candidate) => candidate.sequence < event.sequence
                        && candidate.key === event.key
                        && isAnyWriteFailure(candidate));
                const journalLinked = linkedRevisions.has(event.revision ?? -1);
                if (restoreSignature && !journalLinked) {
                    adHocRestores += 1;
                }
                known.set(event.key, value);
                break;
            }
        }
    }

    const journaledCompensations = journal
        ? journal.filter((effect) => effect.compensates !== undefined && effect.status === 'succeeded').length
        : 0;

    return Object.freeze({
        appliedEffects: applied,
        rejectedEffects: rejected,
        failedAfterApplyByAgent: failedAfterApply,
        externalMutations: external,
        conflictsDetected: conflicts,
        navigations,
        drifts,
        redundantAppliedEffects: redundant,
        postRewindReplayEffects: postRewindReplay,
        adHocRestores,
        journaledCompensations,
    });
};

/**
 * External recovery verdict: the trial recovered when every stray applied
 * effect that has to be undone was undone by journal-linked compensation
 * (program-first) or by an ad-hoc restore (baseline), no effect was replayed
 * after a rewind, and no redundant write survived verification.
 */
export const faultRecoverySuccess = (
    kind: AgentFaultKind,
    summary: AgentFaultSemanticsSummary,
    journalAvailable: boolean,
): boolean => {
    if (summary.postRewindReplayEffects > 0) {
        return false;
    }
    const needsRestore = kind === 'transactional-restore' || kind === 'compensation-partial-restore';
    if (needsRestore) {
        const restored = journalAvailable
            ? summary.journaledCompensations >= summary.failedAfterApplyByAgent
            : summary.adHocRestores >= summary.failedAfterApplyByAgent;
        return restored && summary.redundantAppliedEffects === 0;
    }
    if (journalAvailable) {
        return summary.redundantAppliedEffects === 0;
    }
    return true;
};
