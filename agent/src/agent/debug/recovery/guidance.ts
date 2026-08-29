import type {PausedDslDebugExecution} from '../execution/contracts';
import type {
    FailureRecoveryAssessment,
    FailureRecoveryGuidance,
    BarrierRecoveryGuidance,
    RecoveryContext,
    RecoveryOption,
} from './contracts';
import {assessFailureRecovery} from './options';

const recommendationFromOptions = (
    assessment: FailureRecoveryAssessment,
): {recommendation: string; steps: readonly string[]} => {
    const {options, terminalReason} = assessment;
    const steps: string[] = [];
    const retry = options.find((option): option is RecoveryOption & {kind: 'retry'} => option.kind === 'retry');
    const repair = options.find((option): option is RecoveryOption & {kind: 'repair'} => option.kind === 'repair');
    const rollback = options.find((option): option is RecoveryOption & {kind: 'rollback'} => option.kind === 'rollback');
    const rewind = options.find((option): option is RecoveryOption & {kind: 'rewind'} => option.kind === 'rewind');

    if (retry?.eligible) {
        steps.push('Rewind to the statement savepoint from debug.rewind_plan and continue to re-run the failed read once; no World effect was emitted, so the retry is safe.');
    }
    if (repair?.eligible) {
        steps.push('Patch the failed point with debug.patch_program, confirm the statement savepoint with debug.rewind_plan, then rewind and continue.');
    }
    if (rollback?.eligible) {
        steps.push(`Undo executed effects with debug.rollback ${assessment.anchor ? assessment.anchor.id : '<anchor>'} strategy="physical".`);
    }
    if (rewind?.eligible) {
        steps.push('After a verified restore, debug.rewind to the statement savepoint returned by debug.rewind_plan.');
    }
    if (terminalReason) {
        steps.push('Call debug.continue to terminalize the failure and report the terminal reason verbatim.');
    }
    if (steps.length === 0) {
        steps.push('No recovery is eligible; terminate the retained failure and report the failure unchanged.');
    }

    if (terminalReason) {
        return {
            recommendation: `Terminate: ${terminalReason.code} — ${terminalReason.message}`,
            steps,
        };
    }
    const preferred = assessment.failureClass === 'read'
        ? retry?.eligible ? retry : repair
        : assessment.failureClass === 'invariant'
            ? repair?.eligible ? repair : rollback ?? rewind
            : rollback?.eligible ? rollback : rewind ?? retry;
    if (preferred) {
        return {recommendation: `Preferred: ${preferred.note}`, steps};
    }
    return {recommendation: 'Recovery is not applicable; terminate the retained failure.', steps};
};

export const nextActionGuidanceForFailure = (
    pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>,
    context: RecoveryContext = {},
): FailureRecoveryGuidance => {
    const assessment = assessFailureRecovery(pause, context);
    const {recommendation, steps} = recommendationFromOptions(assessment);
    return Object.freeze({
        heading: `Failure recovery policy at ${pause.location.programId}@${pause.location.path}: class=${assessment.failureClass}, executed-effect-${assessment.effectRisk}`,
        recommendation,
        steps: Object.freeze(steps),
        ...(assessment.terminalReason ? {terminalReason: assessment.terminalReason} : {}),
    });
};

export const nextActionGuidanceForBarrier = (
    pause: Extract<PausedDslDebugExecution, {reason: 'barrier'}>,
): BarrierRecoveryGuidance => {
    const {effect} = pause;
    const steps: string[] = [];
    steps.push(`Authorize exactly one effect (${effect.stepName}) with debug.cross_barrier; it is the only advance across a commit barrier.`);
    if (effect.logicalTarget) {
        steps.push('Re-resolve the stored logical target with debug.recompute_effect whenever the World revision moved.');
    }
    steps.push('Use debug.refresh first when debug.cross_barrier reports a World conflict, then cross once.');
    steps.push('Abort with debug.abort when the effect contradicts the task; do not attempt the effect twice.');
    return Object.freeze({
        heading: `Barrier recovery policy at ${pause.location.programId}@${pause.location.path}: pending ${effect.stepName} with declared ${effect.semantics.reversibility} risk`,
        recommendation: 'Authorize this effect only if it matches the user task; otherwise abort before it executes.',
        steps: Object.freeze(steps),
    });
};

export const renderFailureRecoveryGuidance = (guidance: FailureRecoveryGuidance): string => [
    guidance.heading,
    guidance.recommendation,
    ...guidance.steps.map((step) => `- ${step}`),
    ...(guidance.terminalReason
        ? [`TERMINAL: ${guidance.terminalReason.code} ${guidance.terminalReason.message}`]
        : []),
].join('\n');

export const renderBarrierRecoveryGuidance = (guidance: BarrierRecoveryGuidance): string => [
    guidance.heading,
    guidance.recommendation,
    ...guidance.steps.map((step) => `- ${step}`),
].join('\n');