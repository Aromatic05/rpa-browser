import type {DebugRollbackResult} from '../transaction/contracts';
import type {PausedDslDebugExecution} from '../execution/contracts';
import type {
    FailureRecoveryAssessment,
    RecoveryAfterRollback,
    RecoveryBlock,
    RecoveryBlockCode,
    RecoveryBudgetAction,
    RecoveryBudgetStore,
    RecoveryContext,
    RecoveryOption,
    TerminalRecoveryReason,
} from './contracts';
import {recoveryBudgetKey} from './key';
import {
    aggregateEffectRisk,
    classifyFailure,
    effectsToUndoSince,
    executedEffectsSince,
} from './semantics';

const block = (code: RecoveryBlockCode, message: string): RecoveryBlock =>
    Object.freeze({code, message});

const terminal = (
    code: TerminalRecoveryReason['code'],
    message: string,
): TerminalRecoveryReason => Object.freeze({code, message});

const PRIMARY_BUDGET: Readonly<Record<string, RecoveryBudgetAction>> = Object.freeze({
    read: 'retry',
    invariant: 'repair',
    world_effect: 'rollback',
});

const budgetRemaining = (
    pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>,
    budget: RecoveryBudgetStore | undefined,
    explicitKey: string | undefined,
    action: RecoveryBudgetAction,
): number => {
    if (!budget) {return Number.POSITIVE_INFINITY;}
    const key = explicitKey ?? recoveryBudgetKey(pause, action);
    if (key === undefined) {return Number.POSITIVE_INFINITY;}
    return budget.remaining(key, action);
};

export const assessFailureRecovery = (
    pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>,
    context: RecoveryContext = {},
): FailureRecoveryAssessment => {
    const failureClass = classifyFailure(pause.failure);
    const anchor = pause.rollbackAnchor;
    const journal = context.effects ?? [];
    const executedSinceAnchor = anchor
        ? executedEffectsSince(journal, anchor.effectSequence)
        : [];
    const effectRisk = aggregateEffectRisk(executedSinceAnchor);
    const remainingUndo = anchor ? effectsToUndoSince(journal, anchor.effectSequence) : [];
    const alreadyCompensated = executedSinceAnchor.length > 0 && remainingUndo.length === 0;

    const retryRemaining = budgetRemaining(pause, context.budget, context.budgetKey, 'retry');
    const repairRemaining = budgetRemaining(pause, context.budget, context.budgetKey, 'repair');
    const rollbackRemaining = budgetRemaining(pause, context.budget, context.budgetKey, 'rollback');

    const options: RecoveryOption[] = [];

    const appendRetry = () => {
        if (retryRemaining === 0) {
            options.push(Object.freeze({
                kind: 'retry' as const,
                eligible: false,
                block: block('budget_exhausted', 'retry budget exhausted; do not retry again'),
                note: 'terminate instead',
            }));
            return;
        }
        options.push(Object.freeze({
            kind: 'retry' as const,
            eligible: true,
            note: retryRemaining === Number.POSITIVE_INFINITY
                ? 'safe to retry once: the read emitted no World effect, so rewind to the statement savepoint (debug.rewind_plan) and continue'
                : `safe to retry once: the read emitted no World effect, so rewind to the statement savepoint (debug.rewind_plan) and continue (${retryRemaining} retries remaining)`,
        }));
    };

    const appendRepair = () => {
        if (repairRemaining === 0) {
            options.push(Object.freeze({
                kind: 'repair' as const,
                eligible: false,
                block: block('budget_exhausted', 'repair budget exhausted; a further patch+rewind cycle is blocked'),
                note: 'terminate instead of repairing again',
            }));
            return;
        }
        options.push(Object.freeze({
            kind: 'repair' as const,
            eligible: true,
            note: repairRemaining === Number.POSITIVE_INFINITY
                ? 'patch the failed point with debug.patch_program, then confirm the statement savepoint via debug.rewind_plan before replaying'
                : `patch the failed point with debug.patch_program, then confirm the statement savepoint via debug.rewind_plan before replaying (${repairRemaining} repairs remaining)`,
        }));
    };

    const appendRollback = () => {
        if (!anchor) {
            options.push(Object.freeze({
                kind: 'rollback' as const,
                eligible: false,
                block: block('no_recovery_point', 'no rollback anchor exists; there is nothing to undo yet'),
                strategy: 'physical' as const,
                note: 'a failure before any World effect needs no rollback',
            }));
            return;
        }
        if (effectRisk === 'irreversible') {
            options.push(Object.freeze({
                kind: 'rollback' as const,
                eligible: false,
                block: block('irreversible_effects', 'an executed effect is explicitly irreversible; the World cannot be restored'),
                strategy: 'physical' as const,
                note: 'physical compensation also refuses irreversible effects',
            }));
            return;
        }
        if (rollbackRemaining === 0) {
            options.push(Object.freeze({
                kind: 'rollback' as const,
                eligible: false,
                block: block('budget_exhausted', 'rollback budget exhausted; further undo cycles at this anchor are blocked'),
                strategy: 'physical' as const,
                note: 'terminate instead of undoing again',
            }));
            return;
        }
        const note = alreadyCompensated
            ? 'executed effects are already compensated; rollback would resolve as a noop and will not repeat compensation'
            : effectRisk === 'none'
                ? 'no effects since the anchor; rollback resolves as restored/noop'
                : 'requires strategy="physical"; only declarably reversible effects restore the World, other risk classes stay compensated-with-residual-diff';
        options.push(Object.freeze({
            kind: 'rollback' as const,
            eligible: true,
            strategy: 'physical' as const,
            note,
        }));
    };

    const appendRewind = () => {
        if (!anchor) {
            options.push(Object.freeze({
                kind: 'rewind' as const,
                eligible: false,
                block: block('no_recovery_point', 'no recovery point is known; inspect debug.rewind_plan for a statement savepoint'),
                strategy: 'physical' as const,
                note: 'rewind needs a statement execution savepoint, not a rollback anchor',
            }));
            return;
        }
        if (effectRisk === 'irreversible') {
            options.push(Object.freeze({
                kind: 'rewind' as const,
                eligible: false,
                block: block('irreversible_effects', 'an executed effect is explicitly irreversible; Program replay over it is blocked'),
                strategy: 'physical' as const,
                note: 'verified restore is impossible after an irreversible effect',
            }));
            return;
        }
        if (rollbackRemaining === 0) {
            options.push(Object.freeze({
                kind: 'rewind' as const,
                eligible: false,
                block: block('budget_exhausted', 'rollback budget exhausted; verified rewind is blocked too'),
                strategy: 'physical' as const,
                note: 'terminate instead of rewinding again',
            }));
            return;
        }
        if (effectRisk === 'compensatable' || effectRisk === 'unknown') {
            options.push(Object.freeze({
                kind: 'rewind' as const,
                eligible: false,
                block: block('effects_not_verified', `${effectRisk} effects cannot be verified-restored; rewind stays blocked`),
                strategy: 'physical' as const,
                note: 'compensated is not the same as restored; do not replay Program statements over it',
            }));
            return;
        }
        options.push(Object.freeze({
            kind: 'rewind' as const,
            eligible: true,
            strategy: 'physical' as const,
            note: effectRisk === 'none'
                ? 'no effects since the anchor; rewind to a statement savepoint replays without side effects'
                : 'all executed effects are declarably reversible; pick the statement savepoint from debug.rewind_plan (the rollbackAnchor id is not a statement savepoint)',
        }));
    };

    const appendTerminate = (reason: TerminalRecoveryReason | undefined) => {
        options.push(Object.freeze({
            kind: 'terminate' as const,
            note: reason
                ? 'terminate now and report the failure with the terminal reason'
                : 'terminate the retained failure only when recovery is unwarranted',
            ...(reason ? {reason} : {}),
        }));
    };

    if (failureClass === 'read') {
        appendRetry();
        appendRepair();
    } else if (failureClass === 'invariant') {
        options.push(Object.freeze({
            kind: 'retry' as const,
            eligible: false,
            block: block('effects_not_verified', 'the ensure condition held false; a blind retry reproduces the same invariant'),
            note: 'patch the Program before any retry',
        }));
        appendRepair();
    } else {
        options.push(Object.freeze({
            kind: 'retry' as const,
            eligible: false,
            block: block('effects_not_verified', 'the failed operation writes the World; retrying can duplicate a partially applied effect'),
            note: executedSinceAnchor.length === 0
                ? 'verify debug.effects before any retry'
                : 'undo the executed effects before any retry',
        }));
    }

    appendRollback();
    appendRewind();

    let terminalReason: TerminalRecoveryReason | undefined;
    const primaryRemaining = budgetRemaining(
        pause, context.budget, context.budgetKey, PRIMARY_BUDGET[failureClass],
    );
    if (primaryRemaining === 0) {
        terminalReason = terminal(
            'TERMINAL_RECOVERY_BUDGET_EXHAUSTED',
            `recovery ${PRIMARY_BUDGET[failureClass]} budget exhausted for ${progressPoint(pause)}`,
        );
    } else if (effectRisk === 'irreversible') {
        terminalReason = terminal(
            'TERMINAL_IRREVERSIBLE_EFFECTS',
            'an executed effect is explicitly irreversible; the World cannot be restored',
        );
    } else if (failureClass === 'world_effect' && !anchor) {
        terminalReason = terminal(
            'TERMINAL_NO_RECOVERY_POINT',
            'a World effect failed before any rollback anchor existed; no undo is available',
        );
    } else if (executedSinceAnchor.length > 0 && (effectRisk === 'compensatable' || effectRisk === 'unknown')) {
        terminalReason = terminal(
            'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE',
            `${effectRisk} effects cannot be verified-restored; terminating keeps compensated residual drift`,
        );
    }

    appendTerminate(terminalReason);

    return Object.freeze({
        failure: pause.failure,
        failureClass,
        ...(anchor ? {anchor} : {}),
        executedEffects: Object.freeze([...executedSinceAnchor]),
        effectRisk,
        options: Object.freeze(options),
        ...(terminalReason ? {terminalReason} : {}),
    });
};

const progressPoint = (
    pause: Extract<PausedDslDebugExecution, {reason: 'failure'}>,
): string => `${pause.location.programId}@${pause.location.path}`;

export const recommendRecoveryAfterRollback = (
    rollback: DebugRollbackResult,
): RecoveryAfterRollback => {
    if (rollback.status === 'restored') {
        return rollback.mode === 'noop'
            ? Object.freeze({
                verdict: 'proceed' as const,
                rollback,
                note: 'World is identical to the anchor; continue execution or rewind to a statement savepoint.',
            })
            : Object.freeze({
                verdict: 'rewind_safe' as const,
                rollback,
                note: 'World restoration is verified; rewinding to a statement savepoint (debug.rewind_plan) is allowed.',
            });
    }
    if (rollback.status === 'compensated') {
        return Object.freeze({
            verdict: 'blocked' as const,
            block: block(
                'effects_not_verified',
                `compensation ran but semantic risk is ${rollback.semanticRisk}; compensated is not restored`,
            ),
            terminalReason: terminal(
                'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE',
                'verified restore is impossible for this recovery; do not rewind over compensated effects',
            ),
            rollback,
            note: 'physical compensation completed with residual diff; termination is the safe terminal path.',
        });
    }
    if (rollback.status === 'partial') {
        return Object.freeze({
            verdict: 'blocked' as const,
            block: block(
                'effects_not_verified',
                `compensation failed at sequence ${rollback.failure.code}`,
            ),
            terminalReason: terminal(
                'TERMINAL_COMPENSATION_FAILED',
                `physical compensation failed: ${rollback.failure.message}`,
            ),
            rollback,
            note: 'the World is left in a partially compensated state; do not retry recovery or replay statements.',
        });
    }
    if (rollback.status === 'blocked') {
        if (rollback.reason === 'world_drift') {
            return Object.freeze({
                verdict: 'refresh_required' as const,
                rollback,
                note: 'the World drifted from the paused view; debug.refresh then re-assess recovery.',
            });
        }
        return Object.freeze({
            verdict: 'blocked' as const,
            block: block(
                'effects_not_verified',
                rollback.reason === 'effects_require_compensation'
                    ? 'strategy="none" can only block; use strategy="physical" when UI compensation is appropriate'
                    : `rollback blocked: ${rollback.reason}`,
            ),
            rollback,
            note: 'inspection only; no World change occurred.',
        });
    }
    if (rollback.status === 'conflict') {
        return Object.freeze({
            verdict: 'refresh_required' as const,
            rollback,
            note: 'World moved while paused; debug.refresh then re-decide recovery.',
        });
    }
    return Object.freeze({
        verdict: 'blocked' as const,
        block: block('no_recovery_point', rollback.error.message),
        rollback,
        note: 'the rollback anchor no longer exists; nothing was changed.',
    });
};