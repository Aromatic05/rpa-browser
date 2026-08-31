import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analyzeAgentEvalCorpus,
    classifyRunFailure,
} from '../../../../../../src/agent/execution/eval/analysis';
import {
    analysisToCsv,
    analysisToMarkdown,
    analysisToStableJson,
} from '../../../../../../src/agent/execution/eval/analysis/render';
import {
    agent_eval_analysis_makeCorpusReport,
    agent_eval_analysis_makeRun,
    agent_eval_analysis_makeScenarioReport,
    type AgentEvalAnalysisRunSpec,
} from '../../../../../helpers/agent_eval_analysis_fixtures';
import type {AgentEvalCorpusReport} from '../../../../../../src/agent/execution/eval/corpus';

type RunOverrides = Partial<Omit<AgentEvalAnalysisRunSpec, 'mode' | 'trialIndex'>>;

const programRun = (trialIndex: number, overrides: RunOverrides = {}) =>
    agent_eval_analysis_makeRun({mode: 'program', trialIndex, ...overrides});

const baselineRun = (trialIndex: number, overrides: RunOverrides = {}) =>
    agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex, ...overrides});

const closeTo = (actual: number | null, expected: number, tolerance = 1e-9): void => {
    assert.ok(actual !== null);
    assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
};

const parseCsvLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let quoted = false;
    for (let index = 0; index < line.length; index++) {
        const char = line[index];
        if (quoted) {
            if (char === '"' && line[index + 1] === '"') {
                current += '"';
                index += 1;
            } else if (char === '"') {
                quoted = false;
            } else {
                current += char;
            }
        } else if (char === '"') {
            quoted = true;
        } else if (char === ',') {
            cells.push(current);
            current = '';
        } else {
            current += char;
        }
    }
    cells.push(current);
    return cells;
};

const buildCorpus = (
    seed: number,
    scenarioSpecs: Array<{scenarioId: string; trials: number; runs: ReturnType<typeof agent_eval_analysis_makeRun>[]}>,
): AgentEvalCorpusReport => agent_eval_analysis_makeCorpusReport({
    seed,
    scenarios: scenarioSpecs.map((spec) => agent_eval_analysis_makeScenarioReport({
        scenarioId: spec.scenarioId,
        trials: spec.trials,
        runs: spec.runs,
    })),
});

test('clear Program-first improvement: positive task delta, wins, effect size and fewer turns', () => {
    const report = buildCorpus(7, [{
        scenarioId: 'improve',
        trials: 3,
        runs: [
            programRun(0, {turns: 2, toolCalls: 4, readCalls: 1, controlCalls: 2, effectCalls: 1, durationMs: 100}),
            programRun(1, {turns: 3, toolCalls: 4, durationMs: 100}),
            programRun(2, {turns: 4, toolCalls: 4, durationMs: 100}),
            baselineRun(0, {taskSuccess: false, verificationPassed: false, turns: 5, toolCalls: 7, effectCalls: 2, durationMs: 500}),
            baselineRun(1, {taskSuccess: false, verificationPassed: false, turns: 7, toolCalls: 7, durationMs: 500}),
            baselineRun(2, {taskSuccess: false, verificationPassed: false, turns: 9, toolCalls: 7, durationMs: 500}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const scenario = analysis.scenarios[0];
    assert.equal(scenario.scenarioId, 'improve');
    assert.equal(scenario.matchedPairs, 3);
    const task = scenario.taskSuccess;
    assert.equal(task.programRate, 1);
    assert.equal(task.baselineRate, 0);
    assert.equal(task.delta, 1);
    assert.equal(task.win, 3);
    assert.equal(task.loss, 0);
    assert.equal(task.tie, 0);
    assert.ok(task.ci);
    assert.equal(task.ci.lower, 1);
    assert.equal(task.ci.upper, 1);
    closeTo(task.cohensH, Math.PI);
    const turns = scenario.numeric.turns;
    assert.equal(turns.pairs, 3);
    assert.equal(turns.programMean, 3);
    assert.equal(turns.baselineMean, 7);
    assert.equal(turns.meanDelta, -4);
    assert.ok(turns.ci);
    assert.ok((turns.cohensDz ?? 0) < -3);
    const duration = scenario.numeric.durationMs;
    assert.equal(duration.meanDelta, -400);
});

test('Program-first regression: negative task delta with baseline wins', () => {
    const report = buildCorpus(11, [{
        scenarioId: 'regress',
        trials: 1,
        runs: [
            programRun(0, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
            baselineRun(0, {turns: 2, durationMs: 100}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const task = analysis.scenarios[0].taskSuccess;
    assert.equal(task.delta, -1);
    assert.equal(task.win, 0);
    assert.equal(task.loss, 1);
    assert.equal(task.tie, 0);
    assert.ok((task.ci?.lower ?? 0) <= -1);
    assert.equal(analysis.scenarios[0].numeric.turns.meanDelta, 3);
});

test('ties: zero delta with full tie counts for both pass and fail outcomes', () => {
    const report = buildCorpus(13, [{
        scenarioId: 'tie-pass',
        trials: 2,
        runs: [
            programRun(0, {turns: 3, durationMs: 100}),
            programRun(1, {turns: 3, durationMs: 100}),
            baselineRun(0, {turns: 3, durationMs: 100}),
            baselineRun(1, {turns: 3, durationMs: 100}),
        ],
    }, {
        scenarioId: 'tie-fail',
        trials: 2,
        runs: [
            programRun(0, {taskSuccess: false, verificationPassed: false}),
            programRun(1, {taskSuccess: false, verificationPassed: false}),
            baselineRun(0, {taskSuccess: false, verificationPassed: false}),
            baselineRun(1, {taskSuccess: false, verificationPassed: false}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const pass = analysis.scenarios[0].taskSuccess;
    assert.equal(pass.delta, 0);
    assert.equal(pass.tie, 2);
    assert.equal(pass.win, 0);
    assert.equal(pass.loss, 0);
    closeTo(pass.cohensH, 0);
    const fail = analysis.scenarios[1].taskSuccess;
    assert.equal(fail.delta, 0);
    assert.equal(fail.tie, 2);
    assert.equal(analysis.overall.taskSuccess.tie, 4);
});

test('mixed scenario corpus pools matched pairs per-scenario and overall', () => {
    const report = buildCorpus(17, [{
        scenarioId: 'improve',
        trials: 3,
        runs: [
            programRun(0, {turns: 2, durationMs: 100}),
            programRun(1, {turns: 2, durationMs: 100}),
            programRun(2, {turns: 2, durationMs: 100}),
            baselineRun(0, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
            baselineRun(1, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
            baselineRun(2, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
        ],
    }, {
        scenarioId: 'regress',
        trials: 1,
        runs: [
            programRun(0, {taskSuccess: false, verificationPassed: false}),
            baselineRun(0),
        ],
    }, {
        scenarioId: 'tie-pass',
        trials: 2,
        runs: [
            programRun(0),
            programRun(1),
            baselineRun(0),
            baselineRun(1),
        ],
    }, {
        scenarioId: 'tie-fail',
        trials: 2,
        runs: [
            programRun(0, {taskSuccess: false, verificationPassed: false}),
            programRun(1, {taskSuccess: false, verificationPassed: false}),
            baselineRun(0, {taskSuccess: false, verificationPassed: false}),
            baselineRun(1, {taskSuccess: false, verificationPassed: false}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    assert.equal(analysis.pairing.scenarios, 4);
    assert.equal(analysis.pairing.matchedPairs, 8);
    assert.equal(analysis.overall.taskSuccess.pairs, 8);
    assert.equal(analysis.overall.taskSuccess.programRate, 5 / 8);
    assert.equal(analysis.overall.taskSuccess.baselineRate, 3 / 8);
    closeTo(analysis.overall.taskSuccess.delta ?? 0, 0.25);
    assert.equal(analysis.overall.taskSuccess.win, 3);
    assert.equal(analysis.overall.taskSuccess.loss, 1);
    assert.equal(analysis.overall.taskSuccess.tie, 4);
    assert.equal(analysis.overall.programRuns, 8);
    assert.equal(analysis.overall.baselineRuns, 8);
    assert.equal(analysis.overall.numeric.turns.pairs, 8);
});

test('unmatched trials are surfaced explicitly and never compared silently', () => {
    const report = buildCorpus(19, [{
        scenarioId: 'unmatched',
        trials: 2,
        runs: [
            programRun(0),
            baselineRun(0),
            baselineRun(1),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const scenario = analysis.scenarios[0];
    assert.equal(scenario.matchedPairs, 1);
    assert.equal(scenario.taskSuccess.pairs, 1);
    assert.equal(scenario.unmatchedProgram.length, 0);
    assert.equal(scenario.unmatchedBaseline.length, 1);
    const unmatched = scenario.unmatchedBaseline[0];
    assert.equal(unmatched.scenarioId, 'unmatched');
    assert.equal(unmatched.trialIndex, 1);
    assert.equal(unmatched.mode, 'react-baseline');
    assert.ok(unmatched.seed !== null);
    assert.equal(analysis.pairing.unmatchedBaseline.length, 1);
    assert.equal(analysis.pairing.matchedPairs, 1);
    assert.equal(analysis.overall.matchedPairs, 1);
    const csv = analysisToCsv(analysis);
    assert.match(csv, /unmatched/);
    assert.match(csv, /^unmatched,2,1,0,1,/m, 'csv row exposes the unmatched baseline count');
});

test('failure taxonomy is deterministic and never infers baseline journal facts', () => {
    const report = buildCorpus(23, [{
        scenarioId: 'taxonomy',
        trials: 11,
        runs: [
            programRun(0, {taskSuccess: true}),
            programRun(1, {taskSuccess: false, programStatus: 'aborted'}),
            programRun(2, {taskSuccess: false, programStatus: 'failed', journalEffects: []}),
            programRun(3, {taskSuccess: false, programStatus: 'completed', journalEffects: [{status: 'failed'}]}),
            programRun(4, {taskSuccess: false, programStatus: 'completed', journalEffects: [
                {status: 'failed'},
                {status: 'succeeded', stepName: 'debug.compensate', compensates: 1},
            ]}),
            baselineRun(5, {taskSuccess: false, verificationPassed: false}),
            baselineRun(6, {
                taskSuccess: false,
                verificationPassed: false,
                effectCalls: 1,
                failedToolCalls: 1,
                tools: [{toolName: 'browser.fill', classification: 'effect', isError: true}],
            }),
            baselineRun(7, {
                taskSuccess: false,
                verificationPassed: false,
                effectCalls: 2,
                failedToolCalls: 1,
                postErrorEffectCalls: 1,
                tools: [
                    {toolName: 'browser.fill', classification: 'effect', isError: true},
                    {toolName: 'browser.fill', classification: 'effect'},
                ],
            }),
            baselineRun(8, {
                taskSuccess: false,
                verificationPassed: true,
                effectCalls: 1,
                tools: [{toolName: 'browser.query', classification: 'read', isError: true}],
            }),
            baselineRun(9, {taskSuccess: false, verificationPassed: false, effectCalls: 1}),
            baselineRun(10, {taskSuccess: false, verificationPassed: true, effectCalls: 1}),
        ],
    }]);
    const programRuns = report.reports[0].runs.program ?? [];
    const baselineRuns = report.reports[0].runs['react-baseline'] ?? [];
    const byTrial = (
        runs: readonly ReturnType<typeof agent_eval_analysis_makeRun>[],
        trialIndex: number,
    ): ReturnType<typeof agent_eval_analysis_makeRun> | undefined => runs.find((run) => run.trialIndex === trialIndex);
    assert.equal(classifyRunFailure(byTrial(programRuns, 0)!), null);
    assert.equal(classifyRunFailure(byTrial(programRuns, 1)!), 'governance');
    assert.equal(classifyRunFailure(byTrial(programRuns, 2)!), 'planning');
    assert.equal(classifyRunFailure(byTrial(programRuns, 3)!), 'mutation');
    assert.equal(classifyRunFailure(byTrial(programRuns, 4)!), 'recovery');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 5)!), 'planning');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 6)!), 'mutation');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 7)!), 'recovery');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 8)!), 'read-resolve');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 9)!), 'verification');
    assert.equal(classifyRunFailure(byTrial(baselineRuns, 10)!), 'unknown');

    const analysis = analyzeAgentEvalCorpus(report);
    const taxonomy = analysis.scenarios[0].failureTaxonomy;
    assert.deepEqual(taxonomy.program, {
        planning: 1,
        'read-resolve': 0,
        mutation: 1,
        recovery: 1,
        governance: 1,
        verification: 0,
        unknown: 0,
    });
    assert.deepEqual(taxonomy['react-baseline'], {
        planning: 1,
        'read-resolve': 1,
        mutation: 1,
        recovery: 1,
        governance: 0,
        verification: 1,
        unknown: 1,
    });
});

test('stable JSON, CSV and Markdown render deterministically with unknowns visible', () => {
    const report = buildCorpus(29, [{
        scenarioId: 'improve',
        trials: 2,
        runs: [
            programRun(0, {turns: 2, durationMs: 100}),
            programRun(1, {turns: 2, durationMs: 100}),
            baselineRun(0, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
            baselineRun(1, {taskSuccess: false, verificationPassed: false, turns: 5, durationMs: 500}),
        ],
    }]);
    const first = analyzeAgentEvalCorpus(report);
    const second = analyzeAgentEvalCorpus(report);
    assert.deepEqual(first, second);
    assert.equal(analysisToStableJson(first), analysisToStableJson(second));
    assert.equal(analysisToCsv(first), analysisToCsv(second));
    assert.equal(analysisToMarkdown(first), analysisToMarkdown(second));

    const csv = analysisToCsv(first);
    assert.ok(csv.startsWith('scenario,trials,matchedPairs,unmatchedProgram,unmatchedBaseline,'));
    const csvLines = csv.split('\n').map(parseCsvLine);
    const header = csvLines[0];
    const improveRow = csvLines.find((row) => row[0] === 'improve');
    const overallRow = csvLines.find((row) => row[0] === 'overall');
    assert.ok(improveRow);
    assert.ok(overallRow);
    const cell = (row: string[], key: string): string => row[header.indexOf(key)];
    assert.equal(cell(improveRow, 'taskSuccessProgram'), '1.000');
    assert.equal(cell(improveRow, 'taskSuccessBaseline'), '0.000');
    assert.equal(cell(improveRow, 'taskSuccessDelta'), '1.000');
    assert.equal(cell(improveRow, 'unknownProgram'), '0');
    assert.equal(cell(improveRow, 'unknownBaseline'), '2');
    assert.equal(cell(improveRow, 'recoveryKnownPairs'), '0');
    assert.equal(cell(improveRow, 'failedWorldChangingEffectsProgramMean'), '0.000');
    assert.equal(cell(improveRow, 'failedWorldChangingEffectsBaselineMean'), '');
    assert.equal(cell(improveRow, 'failedWorldChangingEffectsPairs'), 'unknown');
    assert.equal(cell(improveRow, 'd_turns'), '');
    assert.equal(cell(overallRow, 'taskSuccessDelta'), '1.000');
    assert.equal(cell(overallRow, 'unknownBaseline'), '2');
    assert.match(csv, /failedWorldChangingEffectsProgramMean,failedWorldChangingEffectsBaselineMean,failedWorldChangingEffectsPairs/);

    const markdown = analysisToMarkdown(first);
    assert.match(markdown, /# Program-first vs react-baseline: paired analysis/);
    assert.match(markdown, /\| \*\*overall\*\* \|/);
    assert.match(markdown, /recovery Δ \[95% CI\]/);
    assert.match(markdown, /unknown \(program 0, baseline 2\)/);
    assert.match(markdown, /## Failure taxonomy \(failed runs\)/);
    assert.match(markdown, /## Pairing notes/);
    assert.match(markdown, /react-baseline journal metrics stay unknown/);

    const json = analysisToStableJson(first);
    const parsed = JSON.parse(json) as {pairing: {matchedPairs: number}; scenarios: unknown[]; overall: {recoverySuccess: {unknownBaseline: number}}};
    assert.equal(parsed.pairing.matchedPairs, 2);
    assert.equal(parsed.scenarios.length, 1);
    assert.equal(parsed.overall.recoverySuccess.unknownBaseline, 2);
});

const contextVisible = (
    values: {peakChars: number; peakBytes: number; lastChars: number; lastBytes: number},
) => ({availability: 'provider-visible' as const, ...values});

test('Program-first smaller context yields negative mean delta and CI below zero (lower-is-better)', () => {
    const report = buildCorpus(31, [{
        scenarioId: 'ctx-small',
        trials: 3,
        runs: [
            programRun(0, {context: contextVisible({peakChars: 1000, peakBytes: 1200, lastChars: 900, lastBytes: 1100})}),
            programRun(1, {context: contextVisible({peakChars: 1100, peakBytes: 1320, lastChars: 990, lastBytes: 1210})}),
            programRun(2, {context: contextVisible({peakChars: 1200, peakBytes: 1440, lastChars: 1080, lastBytes: 1320})}),
            baselineRun(0, {context: contextVisible({peakChars: 4000, peakBytes: 4800, lastChars: 3800, lastBytes: 4500})}),
            baselineRun(1, {context: contextVisible({peakChars: 4300, peakBytes: 5160, lastChars: 4180, lastBytes: 4950})}),
            baselineRun(2, {context: contextVisible({peakChars: 4600, peakBytes: 5520, lastChars: 4560, lastBytes: 5400})}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const scenario = analysis.scenarios[0];
    assert.equal(scenario.matchedPairs, 3);

    const peakChars = scenario.context.peakChars;
    assert.equal(peakChars.unknown, false);
    assert.equal(peakChars.pairs, 3);
    assert.equal(peakChars.programObservable, 3);
    assert.equal(peakChars.baselineObservable, 3);
    assert.equal(peakChars.unknownProgram, 0);
    assert.equal(peakChars.unknownBaseline, 0);
    closeTo(peakChars.programMean ?? 0, 1100);
    closeTo(peakChars.baselineMean ?? 0, 4300);
    closeTo(peakChars.meanDelta ?? 0, -3200);
    assert.ok(peakChars.ci);
    assert.ok(peakChars.ci.upper < 0, 'deterministic CI excludes zero');
    closeTo(peakChars.cohensDz ?? 0, -16);

    const peakBytes = scenario.context.peakBytes;
    closeTo(peakBytes.meanDelta ?? 0, -3840);
    assert.ok(peakBytes.ci && peakBytes.ci.upper < 0);

    const lastChars = scenario.context.lastChars;
    closeTo(lastChars.meanDelta ?? 0, -3190);
    assert.ok(lastChars.ci && lastChars.ci.upper < 0);

    const lastBytes = scenario.context.lastBytes;
    closeTo(lastBytes.meanDelta ?? 0, -3740);
    assert.ok(lastBytes.ci && lastBytes.ci.upper < 0);

    const csv = analysisToCsv(analysis);
    const csvLines = csv.split('\n').map(parseCsvLine);
    const header = csvLines[0];
    const row = csvLines.find((line) => line[0] === 'ctx-small');
    assert.ok(row);
    const cell = (key: string): string => row[header.indexOf(key)];
    assert.equal(cell('peakCharsDelta'), '-3200.000');
    assert.equal(cell('peakCharsPairs'), '3');
    assert.equal(cell('peakCharsUnknownProgram'), '0');
    assert.equal(cell('peakCharsUnknownBaseline'), '0');
    assert.equal(cell('d_peakChars'), '-16.000');

    const markdown = analysisToMarkdown(analysis);
    assert.match(markdown, /## Context metrics \(provider-visible serialized size\)/);
    assert.match(markdown, /\| peakChars Δ \[95% CI\] \|/);
    assert.match(markdown, /\| \*\*overall\*\* \| -3200\.000 \[/);
    assert.match(markdown, /lower-is-better/);
});

test('context metrics with one side missing stay unknown and excluded, never zero', () => {
    const report = buildCorpus(37, [{
        scenarioId: 'ctx-missing',
        trials: 2,
        runs: [
            programRun(0, {context: contextVisible({peakChars: 1000, peakBytes: 1200, lastChars: 900, lastBytes: 1100})}),
            programRun(1, {context: contextVisible({peakChars: 2000, peakBytes: 2400, lastChars: 1900, lastBytes: 2100})}),
            baselineRun(0),
            baselineRun(1),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const scenario = analysis.scenarios[0];
    assert.equal(scenario.matchedPairs, 2);

    const peakChars = scenario.context.peakChars;
    assert.equal(peakChars.unknown, true);
    assert.equal(peakChars.pairs, 0);
    assert.equal(peakChars.programObservable, 2);
    assert.equal(peakChars.baselineObservable, 0);
    assert.equal(peakChars.unknownProgram, 0);
    assert.equal(peakChars.unknownBaseline, 2);
    closeTo(peakChars.programMean ?? 0, 1500);
    assert.equal(peakChars.baselineMean, null);
    assert.equal(peakChars.meanDelta, null);
    assert.equal(peakChars.ci, null);
    assert.equal(peakChars.meanDelta === 0, false, 'missing side is never coerced to zero');
    assert.equal(peakChars.baselineMean === 0, false);

    const csv = analysisToCsv(analysis);
    const csvLines = csv.split('\n').map(parseCsvLine);
    const header = csvLines[0];
    const row = csvLines.find((line) => line[0] === 'ctx-missing');
    assert.ok(row);
    const cell = (key: string): string => row[header.indexOf(key)];
    assert.equal(cell('peakCharsDelta'), '');
    assert.equal(cell('peakCharsPairs'), 'unknown');
    assert.equal(cell('peakCharsUnknownProgram'), '0');
    assert.equal(cell('peakCharsUnknownBaseline'), '2');
    assert.equal(cell('peakCharsBaselineMean'), '');

    const markdown = analysisToMarkdown(analysis);
    assert.match(markdown, /unknown \(program 0, baseline 2\)/);

    const json = analysisToStableJson(analysis);
    const parsed = JSON.parse(json) as {
        scenarios: [{context: {peakChars: {unknown: boolean; meanDelta: number | null; baselineMean: number | null}}}];
    };
    assert.equal(parsed.scenarios[0]?.context?.peakChars?.unknown, true);
    assert.equal(parsed.scenarios[0]?.context?.peakChars?.meanDelta, null);
    assert.equal(parsed.scenarios[0]?.context?.peakChars?.baselineMean, null);
});

test('context metrics pair only trials where both sides are observable', () => {
    const report = buildCorpus(41, [{
        scenarioId: 'ctx-partial',
        trials: 3,
        runs: [
            programRun(0, {context: contextVisible({peakChars: 1000, peakBytes: 1200, lastChars: 900, lastBytes: 1100})}),
            programRun(1, {context: contextVisible({peakChars: 2000, peakBytes: 2400, lastChars: 1900, lastBytes: 2100})}),
            programRun(2, {context: contextVisible({peakChars: 3000, peakBytes: 3600, lastChars: 2900, lastBytes: 3100})}),
            baselineRun(0),
            baselineRun(1, {context: contextVisible({peakChars: 5000, peakBytes: 6000, lastChars: 4900, lastBytes: 5100})}),
            baselineRun(2, {context: contextVisible({peakChars: 6000, peakBytes: 7200, lastChars: 5900, lastBytes: 6100})}),
        ],
    }]);
    const analysis = analyzeAgentEvalCorpus(report);
    const peakChars = analysis.scenarios[0].context.peakChars;
    assert.equal(peakChars.unknown, false);
    assert.equal(peakChars.pairs, 2);
    assert.equal(peakChars.programObservable, 3);
    assert.equal(peakChars.baselineObservable, 2);
    assert.equal(peakChars.unknownProgram, 0);
    assert.equal(peakChars.unknownBaseline, 1);
    closeTo(peakChars.programMean ?? 0, 2000);
    closeTo(peakChars.baselineMean ?? 0, 5500);
    closeTo(peakChars.meanDelta ?? 0, -3000);
    assert.ok(peakChars.ci && peakChars.ci.upper < 0);
});