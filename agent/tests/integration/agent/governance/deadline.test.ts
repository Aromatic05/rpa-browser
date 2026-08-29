import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTraceSnapshot} from '../../../../src/agent/trace/collector';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {createGovernanceState, withPendingIrreversible} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';
import {traceWith} from './fixtures';

const assertStopReason = (state: AgentTraceSnapshot, policy: Parameters<typeof createGovernancePolicy>[0], startedAt: number, now: number, reason: string): void => {
    const decision = evaluateGovernance(createGovernancePolicy(policy), createGovernanceState({startedAt, initialTrace: state}), now);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, reason);}
};

const assertContinue = (state: AgentTraceSnapshot, policy: Parameters<typeof createGovernancePolicy>[0], startedAt: number, now: number): void => {
    const decision = evaluateGovernance(createGovernancePolicy(policy), createGovernanceState({startedAt, initialTrace: state}), now);
    assert.equal(decision.kind, 'continue');
};

test('deadline: zero elapsed time continues', () => {
    assertContinue(traceWith(), {}, 100, 100);
});

test('deadline: one ms below limit continues', () => {
    assertContinue(traceWith(), {wallClockDeadlineMs: 100}, 100, 199);
});

test('deadline: exactly at limit stops (off-by-one boundary)', () => {
    assertStopReason(traceWith(), {wallClockDeadlineMs: 100}, 100, 200, 'wall-clock-deadline');
});

test('deadline: one ms above limit stops', () => {
    assertStopReason(traceWith(), {wallClockDeadlineMs: 100}, 100, 201, 'wall-clock-deadline');
});

test('deadline: long after start stops regardless of low counts', () => {
    assertStopReason(traceWith(), {wallClockDeadlineMs: 1000}, 0, 5000, 'wall-clock-deadline');
});

test('deadline: priority beats pending irreversible approval', () => {
    const policy = createGovernancePolicy({wallClockDeadlineMs: 100, irreversibleApproval: 'require-human'});
    const base = createGovernanceState({startedAt: 0, initialTrace: traceWith()});
    const state = withPendingIrreversible(base, {sequence: 1, toolName: 'browser.fill', declaredIrreversible: true});
    const decision = evaluateGovernance(policy, state, 200);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'wall-clock-deadline');}
});