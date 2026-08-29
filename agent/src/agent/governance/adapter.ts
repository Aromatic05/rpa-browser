import type {AgentTraceSnapshot} from '../trace/collector';
import {clearPendingIrreversible, snapshotState, withPendingIrreversible, withTrace, createGovernanceState} from './accounting';
import {evaluateGovernance} from './decisions';
import type {EffectObservation, GovernanceDecision, GovernancePolicy, GovernanceState} from './contracts';

export type GovernanceController = {
    evaluate: (now: number) => GovernanceDecision;
    recordTrace: (trace: AgentTraceSnapshot, now: number) => GovernanceDecision;
    checkIrreversible: (effect: EffectObservation, now: number) => GovernanceDecision;
    grantApproval: (now: number) => GovernanceDecision;
    readState: () => GovernanceState;
};

export const createGovernanceController = (policy: GovernancePolicy, startedAt: number): GovernanceController => {
    let state: GovernanceState = createGovernanceState({startedAt});

    const evaluate = (now: number): GovernanceDecision => evaluateGovernance(policy, state, now);

    return {
        evaluate: (now) => evaluate(now),
        recordTrace: (trace, now) => {
            state = withTrace(state, trace);
            return evaluate(now);
        },
        checkIrreversible: (effect, now) => {
            if (!effect.declaredIrreversible) {
                return evaluate(now);
            }
            state = withPendingIrreversible(state, effect);
            return evaluate(now);
        },
        grantApproval: (now) => {
            state = clearPendingIrreversible(state);
            return evaluate(now);
        },
        readState: () => snapshotState(state),
    };
};
