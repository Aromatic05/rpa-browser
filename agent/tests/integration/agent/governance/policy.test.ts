import test from 'node:test';
import assert from 'node:assert/strict';
import {createGovernancePolicy, SAFE_UNATTENDED_POLICY} from '../../../../src/agent/governance/policy';

test('safe unattended policy carries typed non-zero defaults', () => {
    assert.equal(SAFE_UNATTENDED_POLICY.maxTurns, 50);
    assert.equal(SAFE_UNATTENDED_POLICY.maxToolCalls, 200);
    assert.equal(SAFE_UNATTENDED_POLICY.maxWorldEffects, 50);
    assert.equal(SAFE_UNATTENDED_POLICY.maxPostErrorEffects, 5);
    assert.equal(SAFE_UNATTENDED_POLICY.maxRecoveryAttempts, 3);
    assert.equal(SAFE_UNATTENDED_POLICY.wallClockDeadlineMs, 300000);
    assert.equal(SAFE_UNATTENDED_POLICY.irreversibleApproval, 'deny');
});

test('createGovernancePolicy defaults equal the frozen safe policy', () => {
    const policy = createGovernancePolicy();
    assert.deepEqual(policy, SAFE_UNATTENDED_POLICY);
});

test('createGovernancePolicy applies overrides', () => {
    const policy = createGovernancePolicy({maxTurns: 10, irreversibleApproval: 'allow'});
    assert.equal(policy.maxTurns, 10);
    assert.equal(policy.irreversibleApproval, 'allow');
    assert.equal(policy.maxToolCalls, SAFE_UNATTENDED_POLICY.maxToolCalls);
});

test('createGovernancePolicy returns a frozen object', () => {
    assert.ok(Object.isFrozen(createGovernancePolicy()));
    assert.ok(Object.isFrozen(SAFE_UNATTENDED_POLICY));
});

test('maxTurns must be a positive integer', () => {
    assert.throws(() => createGovernancePolicy({maxTurns: 0}), /maxTurns/);
    assert.throws(() => createGovernancePolicy({maxTurns: -1}), /maxTurns/);
    assert.throws(() => createGovernancePolicy({maxTurns: 1.5}), /maxTurns/);
    assert.throws(() => createGovernancePolicy({maxTurns: NaN}), /maxTurns/);
});

test('maxToolCalls must be a positive integer', () => {
    assert.throws(() => createGovernancePolicy({maxToolCalls: 0}), /maxToolCalls/);
    assert.throws(() => createGovernancePolicy({maxToolCalls: -2}), /maxToolCalls/);
});

test('maxWorldEffects must be a positive integer', () => {
    assert.throws(() => createGovernancePolicy({maxWorldEffects: 0}), /maxWorldEffects/);
    assert.throws(() => createGovernancePolicy({maxWorldEffects: 2.5}), /maxWorldEffects/);
});

test('maxPostErrorEffects allows zero but rejects negatives and fractions', () => {
    assert.ok(Number.isInteger(createGovernancePolicy({maxPostErrorEffects: 0}).maxPostErrorEffects));
    assert.throws(() => createGovernancePolicy({maxPostErrorEffects: -1}), /maxPostErrorEffects/);
    assert.throws(() => createGovernancePolicy({maxPostErrorEffects: 0.5}), /maxPostErrorEffects/);
});

test('maxRecoveryAttempts allows zero but rejects negatives and fractions', () => {
    assert.ok(Number.isInteger(createGovernancePolicy({maxRecoveryAttempts: 0}).maxRecoveryAttempts));
    assert.throws(() => createGovernancePolicy({maxRecoveryAttempts: -1}), /maxRecoveryAttempts/);
    assert.throws(() => createGovernancePolicy({maxRecoveryAttempts: 1.5}), /maxRecoveryAttempts/);
});

test('wallClockDeadlineMs must be a positive integer', () => {
    assert.throws(() => createGovernancePolicy({wallClockDeadlineMs: 0}), /wallClockDeadlineMs/);
    assert.throws(() => createGovernancePolicy({wallClockDeadlineMs: -100}), /wallClockDeadlineMs/);
    assert.throws(() => createGovernancePolicy({wallClockDeadlineMs: 10.5}), /wallClockDeadlineMs/);
});

test('irreversibleApproval must be one of deny|require-human|allow', () => {
    assert.throws(() => createGovernancePolicy({irreversibleApproval: 'auto'} as never), /irreversibleApproval/);
    assert.throws(() => createGovernancePolicy({irreversibleApproval: ''} as never), /irreversibleApproval/);
    for (const mode of ['deny', 'require-human', 'allow'] as const) {
        assert.equal(createGovernancePolicy({irreversibleApproval: mode}).irreversibleApproval, mode);
    }
});