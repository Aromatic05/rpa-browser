import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentEvalScenario} from '../../../../../src/agent/execution/eval/harness';
import {
    agentEvalReportToJson,
    allModesPassed,
    toAgentEvalJsonReport,
} from '../../../../../src/agent/execution/eval/report';
import {
    successScenario,
    successRunner,
    unrecoveredFailureScenario,
    unrecoveredFailureRunner,
} from './fixtures';

test('JSON report is serializable and omits raw results by default', async () => {
    const report = await runAgentEvalScenario({runner: successRunner}, successScenario);
    const jsonReport = toAgentEvalJsonReport(report);

    assert.equal(jsonReport.version, 1);
    assert.equal(jsonReport.scenario.id, successScenario.id);
    assert.equal(jsonReport.runs.program?.length, successScenario.trials);
    assert.equal(jsonReport.runs['react-baseline']?.length, successScenario.trials);
    assert.ok(jsonReport.aggregates.program);
    assert.ok(jsonReport.aggregates['react-baseline']);
    assert.equal(jsonReport.runs.program?.[0]?.resultSummary.toolSummary.total, 4);
    assert.equal('rawResult' in (jsonReport.runs.program?.[0] ?? {}), false);

    const json = agentEvalReportToJson(report);
    const parsed = JSON.parse(json);
    assert.equal(parsed.scenario.id, successScenario.id);
    assert.equal(typeof parsed.aggregates.program.durationMs.mean, 'number');
});

test('allModesPassed returns false when a mode fails', async () => {
    const report = await runAgentEvalScenario({runner: unrecoveredFailureRunner}, unrecoveredFailureScenario);
    assert.equal(allModesPassed(report), false);
});

test('allModesPassed returns true when every mode passes', async () => {
    const report = await runAgentEvalScenario(
        {runner: successRunner, modes: ['program']},
        successScenario,
    );
    assert.equal(allModesPassed(report), true);
});

test('report can include raw results when requested', async () => {
    const report = await runAgentEvalScenario({runner: successRunner, modes: ['program']}, successScenario);
    const jsonReport = toAgentEvalJsonReport(report, {includeRawResults: true});
    assert.ok('rawResult' in (jsonReport.runs.program?.[0] ?? {}));
});
