import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentTraceSnapshot} from '../../../../src/agent/trace/collector';
import {createGovernancePolicy} from '../../../../src/agent/governance/policy';
import {createGovernanceState, deriveRecoveryAttempts} from '../../../../src/agent/governance/accounting';
import {evaluateGovernance} from '../../../../src/agent/governance/decisions';
import {tool} from './fixtures';

const programTrace = (): AgentTraceSnapshot => ({
    metrics: {turns: 2, toolCalls: 4, readCalls: 0, controlCalls: 2, effectCalls: 2, failedToolCalls: 1, postErrorEffectCalls: 1},
    tools: [
        tool({toolCallId: 'p1', toolName: 'agent.execute_program', classification: 'control'}),
        tool({toolCallId: 'p2', toolName: 'browser.fill', classification: 'effect', isError: true}),
        tool({toolCallId: 'p3', toolName: 'debug.rollback', classification: 'control'}),
        tool({toolCallId: 'p4', toolName: 'browser.fill', classification: 'effect'}),
    ],
});

const baselineTrace = (): AgentTraceSnapshot => ({
    metrics: {turns: 2, toolCalls: 2, readCalls: 0, controlCalls: 0, effectCalls: 2, failedToolCalls: 1, postErrorEffectCalls: 1},
    tools: [
        tool({toolCallId: 'b1', toolName: 'browser.fill', classification: 'effect', isError: true}),
        tool({toolCallId: 'b2', toolName: 'browser.fill', classification: 'effect'}),
    ],
});

type Scenario = {policy: Parameters<typeof createGovernancePolicy>[0]; metric: keyof AgentTraceSnapshot['metrics']; value: number; reason: string};

const SCENARIOS: Scenario[] = [
    {policy: {maxTurns: 2}, metric: 'turns', value: 2, reason: 'max-turns'},
    {policy: {maxToolCalls: 2}, metric: 'toolCalls', value: 2, reason: 'max-tool-calls'},
    {policy: {maxWorldEffects: 2}, metric: 'effectCalls', value: 2, reason: 'max-world-effects'},
    {policy: {maxPostErrorEffects: 1}, metric: 'postErrorEffectCalls', value: 1, reason: 'max-post-error-effects'},
    {policy: {maxRecoveryAttempts: 1}, metric: 'toolCalls', value: 3, reason: 'max-recovery-attempts'},
];

const evaluate = (trace: AgentTraceSnapshot, policy: Parameters<typeof createGovernancePolicy>[0]): ReturnType<typeof evaluateGovernance> =>
    evaluateGovernance(createGovernancePolicy(policy), createGovernanceState({startedAt: 0, initialTrace: trace}), 100);

test('program-mode and react-baseline recovery traces yield equal recovery attempts', () => {
    assert.equal(deriveRecoveryAttempts(programTrace()), 1);
    assert.equal(deriveRecoveryAttempts(baselineTrace()), 1);
});

test('identical budgets gate program and baseline runs identically (kind and reason)', () => {
    for (const scenario of SCENARIOS) {
        const program = programTrace();
        const baseline = baselineTrace();
        const programDecision = evaluate(program, scenario.policy);
        const baselineDecision = evaluate(baseline, scenario.policy);
        assert.equal(programDecision.kind, 'stop');
        assert.equal(baselineDecision.kind, 'stop');
        if (programDecision.kind === 'stop' && baselineDecision.kind === 'stop') {
            assert.equal(baselineDecision.reason, programDecision.reason, scenario.metric);
            assert.equal(programDecision.reason, scenario.reason);
        }
    }
});

test('decisions never key on tool identity: renamed tools keep identical verdicts', () => {
    for (const scenario of SCENARIOS) {
        const renamed = (base: AgentTraceSnapshot): AgentTraceSnapshot => ({
            ...base,
            tools: base.tools.map((t, index) => ({...t, toolName: `arbitrary.tool_${index}`})),
        });
        const original = evaluate(programTrace(), scenario.policy);
        const renamedDecision = evaluate(renamed(programTrace()), scenario.policy);
        assert.deepEqual(renamedDecision, original);
    }
});

test('below-budget program and baseline runs both continue', () => {
    const generous = {maxTurns: 10, maxToolCalls: 10, maxWorldEffects: 10, maxPostErrorEffects: 5, maxRecoveryAttempts: 3};
    assert.equal(evaluate(programTrace(), generous).kind, 'continue');
    assert.equal(evaluate(baselineTrace(), generous).kind, 'continue');
});