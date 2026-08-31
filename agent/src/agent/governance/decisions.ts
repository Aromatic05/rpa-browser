import {deriveRecoveryAttempts} from './accounting';
import type {GovernanceDecision, GovernancePolicy, GovernanceState} from './contracts';

export const evaluateGovernance = (policy: GovernancePolicy, state: GovernanceState, now: number): GovernanceDecision => {
    if (now - state.startedAt >= policy.wallClockDeadlineMs) {
        return {kind: 'stop', reason: 'wall-clock-deadline'};
    }
    if (state.pendingIrreversible) {
        if (policy.irreversibleApproval === 'deny') {
            return {kind: 'stop', reason: 'irreversible-effect-denied'};
        }
        if (policy.irreversibleApproval === 'require-human') {
            return {
                kind: 'await-approval',
                request: {
                    effectSequence: state.pendingIrreversible.sequence,
                    toolName: state.pendingIrreversible.toolName,
                },
            };
        }
    }
    const {metrics} = state.trace;
    if (metrics.turns >= policy.maxTurns) {
        return {kind: 'stop', reason: 'max-turns'};
    }
    if (metrics.toolCalls >= policy.maxToolCalls) {
        return {kind: 'stop', reason: 'max-tool-calls'};
    }
    if (metrics.effectCalls >= policy.maxWorldEffects) {
        return {kind: 'stop', reason: 'max-world-effects'};
    }
    if (metrics.postErrorEffectCalls > 0 && metrics.postErrorEffectCalls >= policy.maxPostErrorEffects) {
        return {kind: 'stop', reason: 'max-post-error-effects'};
    }
    const recoveryAttempts = deriveRecoveryAttempts(state.trace);
    if (recoveryAttempts > 0 && recoveryAttempts >= policy.maxRecoveryAttempts) {
        return {kind: 'stop', reason: 'max-recovery-attempts'};
    }
    return {kind: 'continue'};
};
