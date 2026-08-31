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

test('context metrics flow into the JSON report and aggregates deterministically', async () => {
    const runner = {
        run: async (request: {executionMode?: 'program' | 'react-baseline'}) => ({
            provider: 'faux',
            model: 'model-x',
            text: 'done',
            executionMode: request.executionMode,
            trace: {
                metrics: {
                    turns: 2, toolCalls: 1, readCalls: 1, controlCalls: 0,
                    effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0,
                },
                tools: [],
                context: {
                    turns: [{turn: 1, chars: 100, bytes: 100}, {turn: 2, chars: 220, bytes: 230}],
                    lastChars: 220,
                    lastBytes: 230,
                    peakChars: 220,
                    peakBytes: 230,
                },
            },
        }),
    };
    const report = await runAgentEvalScenario({runner, modes: ['program']}, successScenario);
    const json = agentEvalReportToJson(report);
    const parsed = JSON.parse(json) as {
        runs: {program: Array<{metrics: {context: {availability: string; peakChars: number; lastBytes: number}}}>};
        aggregates: {program: {context: {
            peakChars: {count: number; mean: number};
            peakBytes: {count: number; mean: number};
            lastChars: {count: number; mean: number};
            lastBytes: {count: number; mean: number};
        }}};
    };
    const metrics = parsed.runs.program[0]?.metrics;
    assert.deepEqual(metrics?.context, {
        availability: 'provider-visible',
        peakChars: 220,
        peakBytes: 230,
        lastChars: 220,
        lastBytes: 230,
    });
    assert.equal(parsed.aggregates.program?.context?.peakChars?.count, successScenario.trials);
    assert.equal(parsed.aggregates.program?.context?.peakChars?.mean, 220);
    assert.ok(!('unknown' in (parsed.aggregates.program?.context?.lastChars ?? {unknown: false})));
    assert.equal(json.includes('provider-visible'), true);
});
