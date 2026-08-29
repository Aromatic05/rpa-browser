import test from 'node:test';
import assert from 'node:assert/strict';
import {createGovernanceController} from '../../../../src/agent/governance/adapter';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {traceWith, tool} from './fixtures';

test('controller evaluates continue before any trace is recorded', () => {
    const controller = createGovernanceController(createGovernancePolicy(), 0);
    assert.equal(controller.evaluate(100).kind, 'continue');
});

test('recordTrace adopts the delivered trace and reflects its metrics', () => {
    const controller = createGovernanceController(createGovernancePolicy({maxTurns: 1}), 0);
    const decision = controller.recordTrace(traceWith({metrics: {turns: 1}}), 100);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-turns');}
    assert.equal(controller.readState().trace.metrics.turns, 1);
});

test('readState returns a defensive deep copy that cannot corrupt internal state', () => {
    const controller = createGovernanceController(createGovernancePolicy(), 0);
    controller.recordTrace(traceWith({metrics: {turns: 1}}), 100);
    const first = controller.readState();
    first.trace.metrics.turns = 77;
    assert.equal(controller.readState().trace.metrics.turns, 1);
    assert.notEqual(controller.readState(), first);
});

test('checkIrreversible only acts on explicitly declared irreversible effects', () => {
    const denied = createGovernanceController(createGovernancePolicy({irreversibleApproval: 'deny'}), 0);
    const notDeclared = denied.checkIrreversible({sequence: 1, toolName: 'browser.fill', declaredIrreversible: false}, 100);
    assert.equal(notDeclared.kind, 'continue');
    assert.equal(denied.readState().pendingIrreversible, undefined);

    const declared = denied.checkIrreversible({sequence: 1, toolName: 'browser.fill', declaredIrreversible: true}, 100);
    assert.equal(declared.kind, 'stop');
    if (declared.kind === 'stop') {assert.equal(declared.reason, 'irreversible-effect-denied');}
    assert.equal(denied.readState().pendingIrreversible?.sequence, 1);
});

test('require-human: declared irreversible effect awaits approval then continues after grant', () => {
    const controller = createGovernanceController(createGovernancePolicy({irreversibleApproval: 'require-human'}), 0);
    const request = controller.checkIrreversible({sequence: 3, toolName: 'browser.batch', declaredIrreversible: true}, 100);
    assert.equal(request.kind, 'await-approval');
    if (request.kind === 'await-approval') {
        assert.equal(request.request.effectSequence, 3);
        assert.equal(request.request.toolName, 'browser.batch');
    }
    const granted = controller.grantApproval(100);
    assert.equal(granted.kind, 'continue');
    assert.equal(controller.readState().pendingIrreversible, undefined);
});

test('require-human: undeclared effect does not trigger approval', () => {
    const controller = createGovernanceController(createGovernancePolicy({irreversibleApproval: 'require-human'}), 0);
    const decision = controller.checkIrreversible({sequence: 1, toolName: 'browser.click', declaredIrreversible: false}, 100);
    assert.equal(decision.kind, 'continue');
});

test('allow mode records but never blocks a declared irreversible effect', () => {
    const controller = createGovernanceController(createGovernancePolicy({irreversibleApproval: 'allow'}), 0);
    const decision = controller.checkIrreversible({sequence: 2, toolName: 'browser.fill', declaredIrreversible: true}, 100);
    assert.equal(decision.kind, 'continue');
    assert.equal(controller.readState().pendingIrreversible?.sequence, 2);
});

test('grantApproval clears the pending effect before limits are re-evaluated', () => {
    const controller = createGovernanceController(createGovernancePolicy({maxTurns: 1, irreversibleApproval: 'require-human'}), 0);
    controller.recordTrace(traceWith(), 100);
    controller.checkIrreversible({sequence: 1, toolName: 'x', declaredIrreversible: true}, 100);
    controller.grantApproval(100);
    const decision = controller.recordTrace(traceWith({metrics: {turns: 2}}), 100);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-turns');}
});

test('controller state transitions are linear and deterministic', () => {
    const controller = createGovernanceController(createGovernancePolicy({maxWorldEffects: 1}), 0);
    const steps = [
        controller.evaluate(100).kind,
        controller.recordTrace(traceWith({metrics: {effectCalls: 1}}), 100).kind,
    ];
    assert.deepEqual(steps, ['continue', 'stop']);
    const repeated = controller.evaluate(100);
    assert.equal(repeated.kind, 'stop');
    assert.deepEqual(controller.readState(), controller.readState());
});

test('recovery exhaustion reports through the controller', () => {
    const controller = createGovernanceController(createGovernancePolicy({maxRecoveryAttempts: 1}), 0);
    const decision = controller.recordTrace(traceWith({tools: [
        tool({toolCallId: '1', isError: true}),
        tool({toolCallId: '2'}),
    ]}), 100);
    assert.equal(decision.kind, 'stop');
    if (decision.kind === 'stop') {assert.equal(decision.reason, 'max-recovery-attempts');}
});