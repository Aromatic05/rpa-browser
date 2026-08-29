import test from 'node:test';
import assert from 'node:assert/strict';
import {createGovernanceState, withTrace, withPendingIrreversible, clearPendingIrreversible, snapshotState} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {traceWith, tool, emptyTrace} from './fixtures';

test('createGovernanceState clones the initial trace (no shared mutable reference)', () => {
    const input = traceWith({metrics: {effectCalls: 1}, tools: [tool({toolCallId: '1'})]});
    const state = createGovernanceState({startedAt: 0, initialTrace: input});
    input.metrics.effectCalls = 99;
    input.tools.length = 0;
    assert.equal(state.trace.metrics.effectCalls, 1);
    assert.equal(state.trace.tools.length, 1);
});

test('withTrace clones the incoming trace and never mutates the prior state', () => {
    const base = createGovernanceState({startedAt: 0, initialTrace: emptyTrace()});
    const next = withTrace(base, traceWith({metrics: {turns: 1}}));
    assert.notEqual(next, base);
    assert.equal(base.trace.metrics.turns, 0);
    assert.equal(next.trace.metrics.turns, 1);
});

test('withTrace guards against later mutation of the supplied trace', () => {
    const input = traceWith({metrics: {turns: 1}});
    const next = withTrace(createGovernanceState({startedAt: 0}), input);
    input.metrics.turns = 50;
    assert.equal(next.trace.metrics.turns, 1);
});

test('withPendingIrreversible returns a new state and leaves the base untouched', () => {
    const base = createGovernanceState({startedAt: 0});
    const next = withPendingIrreversible(base, {sequence: 1, toolName: 'browser.fill', declaredIrreversible: true});
    assert.notEqual(next, base);
    assert.equal(base.pendingIrreversible, undefined);
    assert.equal(next.pendingIrreversible?.sequence, 1);
});

test('withPendingIrreversible clones the supplied effect (no reference aliasing)', () => {
    const effect = {sequence: 5, toolName: 'browser.fill', declaredIrreversible: true};
    const next = withPendingIrreversible(createGovernanceState({startedAt: 0}), effect);
    effect.sequence = 99;
    const snapshot = snapshotState(next);
    assert.equal(snapshot.pendingIrreversible?.sequence, 5);
    assert.notEqual(next.pendingIrreversible, effect);
});

test('clearPendingIrreversible returns a new state and leaves the input untouched', () => {
    const pending = withPendingIrreversible(createGovernanceState({startedAt: 0}), {sequence: 1, toolName: 'x', declaredIrreversible: true});
    const cleared = clearPendingIrreversible(pending);
    assert.notEqual(cleared, pending);
    assert.ok(pending.pendingIrreversible !== undefined);
    assert.equal(cleared.pendingIrreversible, undefined);
});

test('snapshotState deep-isolates mutations of metrics', () => {
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({metrics: {turns: 3}})});
    const snapshot = snapshotState(state);
    snapshot.trace.metrics.turns = 999;
    snapshot.trace.tools.push(tool({toolCallId: 'x'}));
    assert.equal(state.trace.metrics.turns, 3);
    assert.equal(state.trace.tools.length, 0);
});

test('snapshotState deep-isolates nested mutable containers', () => {
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({tools: [tool({toolCallId: '1', args: {a: 1}})]})});
    const snapshot = snapshotState(state);
    snapshot.trace.tools[0].args = {b: 2};
    assert.deepEqual(state.trace.tools[0].args, {a: 1});
});

test('snapshotState clones the pending irreversible effect', () => {
    const pending = withPendingIrreversible(createGovernanceState({startedAt: 0}), {sequence: 9, toolName: 'browser.click', declaredIrreversible: true});
    const snapshot = snapshotState(pending);
    assert.notEqual(snapshot.pendingIrreversible, pending.pendingIrreversible);
    assert.deepEqual(snapshot.pendingIrreversible, pending.pendingIrreversible);
});

test('evaluateGovernance is pure: repeated evaluation yields identical decisions and no state mutation', () => {
    const policy = createGovernancePolicy({maxTurns: 1});
    const state = createGovernanceState({startedAt: 0, initialTrace: traceWith({metrics: {turns: 1}})});
    const before = snapshotState(state);
    const first = evaluateGovernance(policy, state, 100);
    const second = evaluateGovernance(policy, state, 100);
    assert.deepEqual(first, second);
    assert.deepEqual(snapshotState(state), before);
    assert.deepEqual(state.trace.metrics.turns, 1);
});

test('governance state surface exposes only the immutable contract fields', () => {
    const state = createGovernanceState({startedAt: 0});
    const keys = Object.keys(state).sort();
    assert.deepEqual(keys, ['startedAt', 'trace']);
});