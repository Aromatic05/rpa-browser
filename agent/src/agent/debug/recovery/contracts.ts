import type {DslFailureDescriptor} from '../../../automation/dsl/debug/contracts';
import type {DebugEffectRecord} from '../effects/contracts';
import type {DebugSavepoint, DebugRollbackResult} from '../transaction/contracts';

export type FailureClass = 'read' | 'invariant' | 'world_effect';

export type ExecutedEffectRisk = 'none' | 'reversible' | 'compensatable' | 'unknown' | 'irreversible';

export type RecoveryBlockCode =
    | 'no_recovery_point'
    | 'effects_not_verified'
    | 'irreversible_effects'
    | 'already_compensated'
    | 'budget_exhausted';

export type RecoveryBlock = Readonly<{
    code: RecoveryBlockCode;
    message: string;
}>;

export type RecoveryOption =
    | Readonly<{kind: 'retry'; eligible: boolean; block?: RecoveryBlock; note: string}>
    | Readonly<{kind: 'repair'; eligible: boolean; block?: RecoveryBlock; note: string}>
    | Readonly<{
        kind: 'rollback';
        eligible: boolean;
        block?: RecoveryBlock;
        strategy: 'physical';
        note: string;
    }>
    | Readonly<{
        kind: 'rewind';
        eligible: boolean;
        block?: RecoveryBlock;
        strategy: 'physical';
        note: string;
    }>
    | Readonly<{kind: 'terminate'; note: string; reason?: TerminalRecoveryReason}>;

export type TerminalRecoveryCode =
    | 'TERMINAL_NO_RECOVERY_POINT'
    | 'TERMINAL_VERIFIED_RESTORE_IMPOSSIBLE'
    | 'TERMINAL_COMPENSATION_FAILED'
    | 'TERMINAL_IRREVERSIBLE_EFFECTS'
    | 'TERMINAL_RECOVERY_BUDGET_EXHAUSTED';

export type TerminalRecoveryReason = Readonly<{
    code: TerminalRecoveryCode;
    message: string;
}>;

export type FailureRecoveryAssessment = Readonly<{
    failure: DslFailureDescriptor;
    failureClass: FailureClass;
    anchor?: DebugSavepoint;
    executedEffects: readonly DebugEffectRecord[];
    effectRisk: ExecutedEffectRisk;
    options: readonly RecoveryOption[];
    terminalReason?: TerminalRecoveryReason;
}>;

export type RecoveryBudgetAction = 'retry' | 'repair' | 'rollback';

export type RecoveryBudgetLimits = Readonly<Record<RecoveryBudgetAction, number>>;

export type RecoveryBudgetView = Readonly<{
    key: string;
    retry: number;
    repair: number;
    rollback: number;
}>;

export type RecoveryBudgetStore = {
    view: (key: string) => RecoveryBudgetView;
    record: (key: string, action: RecoveryBudgetAction) => RecoveryBudgetView;
    remaining: (key: string, action: RecoveryBudgetAction) => number;
};

export type RecoveryContext = Readonly<{
    effects?: readonly DebugEffectRecord[];
    budget?: RecoveryBudgetStore;
    budgetKey?: string;
}>;

export type RecoveryAfterRollback =
    | Readonly<{
        verdict: 'proceed' | 'rewind_safe';
        rollback: DebugRollbackResult;
        note: string;
    }>
    | Readonly<{
        verdict: 'blocked';
        block: RecoveryBlock;
        terminalReason?: TerminalRecoveryReason;
        rollback: DebugRollbackResult;
        note: string;
    }>
    | Readonly<{
        verdict: 'refresh_required';
        rollback: DebugRollbackResult;
        note: string;
    }>;

export type FailureRecoveryGuidance = Readonly<{
    heading: string;
    recommendation: string;
    steps: readonly string[];
    terminalReason?: TerminalRecoveryReason;
}>;

export type BarrierRecoveryGuidance = Readonly<{
    heading: string;
    recommendation: string;
    steps: readonly string[];
}>;