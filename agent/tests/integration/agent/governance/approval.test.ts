import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTraceSnapshot} from '../../../../src/agent/trace/collector';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {createGovernanceState, withPendingIrreversible, clearPendingIrreversible} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';

const emptyTrace = (): AgentTraceSnapshot => ({
    metrics: {turns: 0, toolCalls: 0, readCalls: 0, controlCalls: 0, effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0},
    tools: [],
});

const NOW = 1000;

test('deny mode: pending irreversible effect stops', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'deny'});
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const state = withPendingIrreversible(base, {sequence: 1, toolName: 'browser.fill', declaredIrreversible: true});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'irreversible-effect-denied');}
});

test('require-human mode: pending irreversible effect awaits approval', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'require-human'});
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const state = withPendingIrreversible(base, {sequence: 7, toolName: 'browser.click', declaredIrreversible: true});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'await-approval');
    if (decision.kind === 'await-approval') {
        assert.equal(decision.request.effectSequence, 7);
        assert.equal(decision.request.toolName, 'browser.click');
    }
});

test('allow mode: pending irreversible effect continues', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'allow'});
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const state = withPendingIrreversible(base, {sequence: 1, toolName: 'browser.fill', declaredIrreversible: true});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('no pending irreversible: all modes continue', () => {
    for (const mode of ['deny', 'require-human', 'allow'] as const) {
        const policy = createGovernancePolicy({irreversibleApproval: mode});
        const state = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
        assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
    }
});

test('clearing pending irreversible restores continue under deny', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'deny'});
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const pending = withPendingIrreversible(base, {sequence: 1, toolName: 'x', declaredIrreversible: true});
    assert.equal(evaluateGovernance(policy, pending, NOW).kind, 'stop');
    const cleared = clearPendingIrreversible(pending);
    assert.equal(evaluateGovernance(policy, cleared, NOW).kind, 'continue');
});

test('approval request carries correct sequence and tool name', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'require-human'});
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const state = withPendingIrreversible(base, {sequence: 42, toolName: 'browser.batch', declaredIrreversible: true});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'await-approval');
    if (decision.kind === 'await-approval') {
        assert.equal(decision.request.effectSequence, 42);
        assert.equal(decision.request.toolName, 'browser.batch');
    }
});

test('irreversible denial takes priority over count limits', () => {
    const policy = createGovernancePolicy({maxTurns: 1, irreversibleApproval: 'deny'});
    const base = createGovernanceState({startedAt: 0, initialTrace: {
        metrics: {turns: 5, toolCalls: 0, readCalls: 0, controlCalls: 0, effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0},
        tools: [],
    }});
    const state = withPendingIrreversible(base, {sequence: 1, toolName: 'x', declaredIrreversible: true});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'irreversible-effect-denied');}
});

test('governance never infers reversibility from tool name alone', () => {
    const policy = createGovernancePolicy({irreversibleApproval: 'deny'});
    const state = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'continue');
});
