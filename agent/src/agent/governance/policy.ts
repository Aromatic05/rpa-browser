import type {GovernancePolicy, IrreversibleApprovalMode} from './contracts';

export const SAFE_UNATTENDED_POLICY: GovernancePolicy = Object.freeze({
    maxTurns: 50,
    maxToolCalls: 200,
    maxWorldEffects: 50,
    maxPostErrorEffects: 5,
    maxRecoveryAttempts: 3,
    wallClockDeadlineMs: 5 * 60 * 1000,
    irreversibleApproval: 'deny',
});

const VALID_APPROVAL_MODES: readonly IrreversibleApprovalMode[] = ['deny', 'require-human', 'allow'];

const assertPositiveInteger = (value: number, name: string): void => {
    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer, got ${value}`);
    }
};

const assertNonNegativeInteger = (value: number, name: string): void => {
    if (!Number.isInteger(value) || value < 0) {
        throw new Error(`${name} must be a non-negative integer, got ${value}`);
    }
};

export const createGovernancePolicy = (overrides: Partial<GovernancePolicy> = {}): GovernancePolicy => {
    const policy: GovernancePolicy = {
        ...SAFE_UNATTENDED_POLICY,
        ...overrides,
    };
    assertPositiveInteger(policy.maxTurns, 'maxTurns');
    assertPositiveInteger(policy.maxToolCalls, 'maxToolCalls');
    assertPositiveInteger(policy.maxWorldEffects, 'maxWorldEffects');
    assertNonNegativeInteger(policy.maxPostErrorEffects, 'maxPostErrorEffects');
    assertNonNegativeInteger(policy.maxRecoveryAttempts, 'maxRecoveryAttempts');
    assertPositiveInteger(policy.wallClockDeadlineMs, 'wallClockDeadlineMs');
    if (!VALID_APPROVAL_MODES.includes(policy.irreversibleApproval)) {
        throw new Error(`irreversibleApproval must be one of ${VALID_APPROVAL_MODES.join(', ')}, got ${policy.irreversibleApproval}`);
    }
    return Object.freeze(policy);
};
