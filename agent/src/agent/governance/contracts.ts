import type {AgentTraceSnapshot} from '../trace/collector';

export type IrreversibleApprovalMode = 'deny' | 'require-human' | 'allow';

export type GovernancePolicy = Readonly<{
    maxTurns: number;
    maxToolCalls: number;
    maxWorldEffects: number;
    maxPostErrorEffects: number;
    maxRecoveryAttempts: number;
    wallClockDeadlineMs: number;
    irreversibleApproval: IrreversibleApprovalMode;
}>;

export type GovernanceStopReason =
    | 'max-turns'
    | 'max-tool-calls'
    | 'max-world-effects'
    | 'max-post-error-effects'
    | 'max-recovery-attempts'
    | 'wall-clock-deadline'
    | 'irreversible-effect-denied';

export type GovernanceApprovalRequest = Readonly<{
    effectSequence: number;
    toolName: string;
}>;

export type GovernanceDecision =
    | Readonly<{kind: 'continue'}>
    | Readonly<{kind: 'stop'; reason: GovernanceStopReason}>
    | Readonly<{kind: 'await-approval'; request: GovernanceApprovalRequest}>;

export type EffectObservation = Readonly<{
    sequence: number;
    toolName: string;
    declaredIrreversible: boolean;
}>;

export type GovernanceState = Readonly<{
    trace: AgentTraceSnapshot;
    startedAt: number;
    pendingIrreversible?: EffectObservation;
}>;
