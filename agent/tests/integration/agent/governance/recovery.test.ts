import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentToolTrace} from '../../../../src/agent/trace/collector';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {createGovernanceState, deriveRecoveryAttempts} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';
import {traceWith, tool, emptyTrace} from './fixtures';

const attemptsOf = (tools: AgentToolTrace[]): number => deriveRecoveryAttempts(traceWith({tools}));

test('deriveRecoveryAttempts: empty trace is zero', () => {
    assert.equal(deriveRecoveryAttempts(emptyTrace()), 0);
});

test('deriveRecoveryAttempts: all-succeed sequence is zero', () => {
    assert.equal(attemptsOf([tool({toolCallId: '1'}), tool({toolCallId: '2'}), tool({toolCallId: '3'})]), 0);
});

test('deriveRecoveryAttempts: lone error is zero (nothing recovered)', () => {
    assert.equal(attemptsOf([tool({toolCallId: '1', isError: true}), tool({toolCallId: '2', isError: true})]), 0);
});

test('deriveRecoveryAttempts: error followed by success is one attempt', () => {
    assert.equal(attemptsOf([
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
    ]), 1);
});

test('deriveRecoveryAttempts: consecutive errors then success is one attempt', () => {
    assert.equal(attemptsOf([
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2', isError: true}),
        tool({toolCallId: '3'}),
    ]), 1);
});

test('deriveRecoveryAttempts: error, success, error, success is two attempts', () => {
    assert.equal(attemptsOf([
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
        tool({toolCallId: '3', isError: true}),
        tool({toolCallId: '4'}),
    ]), 2);
});

test('deriveRecoveryAttempts: recovery only counted at error-success transition', () => {
    assert.equal(attemptsOf([
        tool({toolCallId: '1'}),
        tool({toolCallId: '2'}),
        tool({toolCallId: '3', isError: true}),
        tool({toolCallId: '4'}),
        tool({toolCallId: '5', isError: true}),
        tool({toolCallId: '6', isError: true}),
        tool({toolCallId: '7'}),
    ]), 2);
});

test('maxRecoveryAttempts: zero limit with no attempts continues', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 0});
    const state = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    assert.equal(evaluateGovernance(policy, state, 1).kind, 'continue');
});

test('maxRecoveryAttempts: zero limit with one attempt stops', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 0});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
    ]})});
    const decision = evaluateGovernance(policy, state, 1);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-recovery-attempts');}
});

test('maxRecoveryAttempts: below limit continues', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 2});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
    ]})});
    assert.equal(evaluateGovernance(policy, state, 1).kind, 'continue');
});

test('maxRecoveryAttempts: at limit stops (off-by-one boundary)', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 1});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
    ]})});
    const decision = evaluateGovernance(policy, state, 1);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-recovery-attempts');}
});

test('maxRecoveryAttempts: above limit stops (off-by-one boundary)', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 1});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
        tool({toolCallId: '3', isError: true}),
        tool({toolCallId: '4'}),
    ]})});
    const decision = evaluateGovernance(policy, state, 1);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-recovery-attempts');}
});

test('maxRecoveryAttempts: failing retries do not consume extra attempts', () => {
    const policy = createGovernancePolicy({maxRecoveryAttempts: 2});
    const collapsed = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2', isError: true}),
        tool({toolCallId: '3', isError: true}),
        tool({toolCallId: '4'}),
    ]})});
    assert.equal(deriveRecoveryAttempts(collapsed.trace), 1);
    assert.equal(evaluateGovernance(policy, collapsed, 1).kind, 'continue');

    const notCollapsed = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
        tool({toolCallId: '3', isError: true}),
        tool({toolCallId: '4'}),
    ]})});
    assert.equal(deriveRecoveryAttempts(notCollapsed.trace), 2);
    const decision = evaluateGovernance(policy, notCollapsed, 1);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-recovery-attempts');}
});