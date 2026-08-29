import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTraceSnapshot} from '../../../../src/agent/trace/collector';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {createGovernanceState} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';

const emptyTrace = (): AgentTraceSnapshot => ({
    metrics: {turns: 0, toolCalls: 0, readCalls: 0, controlCalls: 0, effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0},
    tools: [],
});

const traceWith = (metrics: Partial<AgentTraceSnapshot['metrics']>): AgentTraceSnapshot => ({
    metrics: {turns: 0, toolCalls: 0, readCalls: 0, controlCalls: 0, effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0, ...metrics},
    tools: [],
});

const NOW = 1000;

test('maxTurns: below limit continues', () => {
    const policy = createGovernancePolicy({maxTurns: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 2})});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('maxTurns: at limit stops', () => {
    const policy = createGovernancePolicy({maxTurns: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 3})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-turns');}
});

test('maxTurns: above limit stops', () => {
    const policy = createGovernancePolicy({maxTurns: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 4})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-turns');}
});

test('maxTurns: boundary at 1', () => {
    const policy = createGovernancePolicy({maxTurns: 1});
    const stateAt0 = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 0})});
    assert.equal(evaluateGovernance(policy, stateAt0, NOW).kind, 'continue');
    const stateAt1 = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 1})});
    const decision = evaluateGovernance(policy, stateAt1, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-turns');}
});

test('maxToolCalls: below limit continues', () => {
    const policy = createGovernancePolicy({maxToolCalls: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({toolCalls: 4})});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('maxToolCalls: at limit stops', () => {
    const policy = createGovernancePolicy({maxToolCalls: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({toolCalls: 5})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-tool-calls');}
});

test('maxToolCalls: off-by-one above limit', () => {
    const policy = createGovernancePolicy({maxToolCalls: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({toolCalls: 6})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-tool-calls');}
});

test('maxWorldEffects: below limit continues', () => {
    const policy = createGovernancePolicy({maxWorldEffects: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({effectCalls: 2})});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('maxWorldEffects: at limit stops', () => {
    const policy = createGovernancePolicy({maxWorldEffects: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({effectCalls: 3})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-world-effects');}
});

test('maxWorldEffects: off-by-one above limit', () => {
    const policy = createGovernancePolicy({maxWorldEffects: 3});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({effectCalls: 4})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-world-effects');}
});

test('maxPostErrorEffects: zero limit with zero calls continues', () => {
    const policy = createGovernancePolicy({maxPostErrorEffects: 0});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({postErrorEffectCalls: 0})});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('maxPostErrorEffects: zero limit with one call stops', () => {
    const policy = createGovernancePolicy({maxPostErrorEffects: 0});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({postErrorEffectCalls: 1})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-post-error-effects');}
});

test('maxPostErrorEffects: nonzero below limit continues', () => {
    const policy = createGovernancePolicy({maxPostErrorEffects: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({postErrorEffectCalls: 4})});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('maxPostErrorEffects: nonzero at limit stops', () => {
    const policy = createGovernancePolicy({maxPostErrorEffects: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({postErrorEffectCalls: 5})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-post-error-effects');}
});

test('maxPostErrorEffects: nonzero off-by-one above limit', () => {
    const policy = createGovernancePolicy({maxPostErrorEffects: 5});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({postErrorEffectCalls: 6})});
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-post-error-effects');}
});

test('empty trace with default policy continues', () => {
    const policy = createGovernancePolicy();
    const state = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    assert.equal(evaluateGovernance(policy, state, NOW).kind, 'continue');
});

test('stop reason priority: deadline beats counts', () => {
    const policy = createGovernancePolicy({maxTurns: 1, wallClockDeadlineMs: 100});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 5})});
    const decision = evaluateGovernance(policy, state, 200);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'wall-clock-deadline');}
});

test('stop reason priority: irreversible beats counts', () => {
    const policy = createGovernancePolicy({maxTurns: 1, irreversibleApproval: 'deny'});
    const state = {
        ...createGovernanceState({startedAt: 0, initialTrace: traceWith({turns: 5})}),
        pendingIrreversible: {sequence: 1, toolName: 'x', declaredIrreversible: true},
    };
    const decision = evaluateGovernance(policy, state, NOW);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'irreversible-effect-denied');}
});
