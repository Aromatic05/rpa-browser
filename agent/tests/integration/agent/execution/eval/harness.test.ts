import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentEvalScenario} from '../../../../../src/agent/execution/eval/harness';
import {
    recoveredFailureRunner,
    recoveredFailureScenario,
    successRunner,
    successScenario,
} from './fixtures';

test('scenario harness repeats trials and aggregates per mode', async () => {
    const report = await runAgentEvalScenario({runner: successRunner}, successScenario);
    assert.equal(report.scenario.id, successScenario.id);
    assert.equal(report.runs.program?.length, successScenario.trials);
    assert.equal(report.runs['react-baseline']?.length, successScenario.trials);
    assert.equal(report.aggregates.program?.trials, successScenario.trials);
    assert.equal(report.aggregates['react-baseline']?.trials, successScenario.trials);
    assert.equal(report.aggregates.program?.taskSuccess.rate, 1);
});

test('scenario harness marks recovery success when compensation is present', async () => {
    const report = await runAgentEvalScenario(
        {runner: recoveredFailureRunner, modes: ['program']},
        recoveredFailureScenario,
    );
    const programRuns = report.runs.program;
    assert.ok(programRuns);
    assert.equal(programRuns[0]?.metrics.recoverySuccess, true);
    assert.equal(programRuns[0]?.metrics.effects.failedWorldChangingEffects, 1);
    assert.equal(programRuns[0]?.metrics.effects.compensationEffects, 1);
    assert.equal(report.aggregates.program?.recoverySuccess && 'passed' in report.aggregates.program.recoverySuccess
        ? report.aggregates.program.recoverySuccess.passed
        : null, report.runs.program!.length);
});

test('harness mode override restricts execution', async () => {
    const report = await runAgentEvalScenario(
        {runner: successRunner, modes: ['program']},
        successScenario,
    );
    assert.equal(report.runs['react-baseline'], undefined);
    assert.equal(report.runs.program?.length, successScenario.trials);
});
