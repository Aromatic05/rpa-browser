import test from 'node:test';
import assert from 'node:assert/strict';
import {
    analysisBootstrapSeed,
    cohensDz,
    cohensH,
    pairedMeanDeltaCI,
    pairedRateDeltaCI,
} from '../../../../../../src/agent/execution/eval/analysis/bootstrap';
import {
    analyzeAgentEvalCorpus,
    analyzeAgentEvalScenario,
} from '../../../../../../src/agent/execution/eval/analysis/analyze';
import {analysisToMarkdown} from '../../../../../../src/agent/execution/eval/analysis/render';
import {
    agent_eval_analysis_makeCorpusReport,
    agent_eval_analysis_makeRun,
    agent_eval_analysis_makeScenarioReport,
} from '../../../../../helpers/agent_eval_analysis_fixtures';

test('paired mean delta bootstrap CI is deterministic per seed and brackets the mean', () => {
    const diffs = [1, -2, 3, 0, 4, -1, 2, 5, -3, 2];
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const first = pairedMeanDeltaCI(diffs, {seed: 4242, iterations: 500, level: 0.95});
    const second = pairedMeanDeltaCI(diffs, {seed: 4242, iterations: 500, level: 0.95});
    assert.ok(first);
    assert.ok(second);
    assert.deepEqual(first, second);
    assert.equal(first.seed, 4242);
    assert.equal(first.iterations, 500);
    assert.equal(first.level, 0.95);
    assert.ok(first.lower <= mean && mean <= first.upper, `${mean} outside [${first.lower}, ${first.upper}]`);
    const differentSeed = pairedMeanDeltaCI(diffs, {seed: 4243, iterations: 500, level: 0.95});
    assert.ok(differentSeed);
    assert.equal(pairedMeanDeltaCI([], {seed: 1}), null);
});

test('paired success-rate bootstrap CI is deterministic and brackets the observed delta', () => {
    const pairs = [
        {program: true, baseline: false},
        {program: true, baseline: false},
        {program: false, baseline: true},
        {program: true, baseline: true},
        {program: false, baseline: false},
    ];
    const delta = 2 / 5 - 1 / 5;
    const first = pairedRateDeltaCI(pairs, {seed: 99, iterations: 400, level: 0.9});
    const second = pairedRateDeltaCI(pairs, {seed: 99, iterations: 400, level: 0.9});
    assert.ok(first);
    assert.deepEqual(first, second);
    assert.ok(first.lower <= delta && delta <= first.upper, `${delta} outside [${first.lower}, ${first.upper}]`);
    assert.equal(pairedRateDeltaCI([], {seed: 1}), null);
});

test('tiny N produces a deterministic point confidence interval', () => {
    const point = pairedMeanDeltaCI([5], {seed: 3, iterations: 100, level: 0.95});
    assert.ok(point);
    assert.equal(point.lower, 5);
    assert.equal(point.upper, 5);
    const ratePoint = pairedRateDeltaCI([{program: true, baseline: false}], {seed: 3, iterations: 100, level: 0.95});
    assert.ok(ratePoint);
    assert.equal(ratePoint.lower, 1);
    assert.equal(ratePoint.upper, 1);
    const twoDiff = pairedMeanDeltaCI([1, 2], {seed: 3, iterations: 200, level: 0.95});
    assert.ok(twoDiff);
    assert.ok(twoDiff.lower >= 1 && twoDiff.upper <= 2);
});

test('tiny-N corpus analysis still reports deterministic CIs and full sample counts', () => {
    const report = agent_eval_analysis_makeCorpusReport({
        seed: 5,
        scenarios: [agent_eval_analysis_makeScenarioReport({
            scenarioId: 'single',
            trials: 1,
            runs: [
                agent_eval_analysis_makeRun({mode: 'program', trialIndex: 0, turns: 2, durationMs: 100}),
                agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex: 0, taskSuccess: false, verificationPassed: false, turns: 9, durationMs: 900}),
            ],
        })],
    });
    const first = analyzeAgentEvalCorpus(report);
    const second = analyzeAgentEvalCorpus(report);
    assert.deepEqual(first, second);
    const scenario = first.scenarios[0];
    assert.equal(scenario.matchedPairs, 1);
    assert.equal(scenario.taskSuccess.pairs, 1);
    assert.equal(scenario.taskSuccess.ci?.lower, 1);
    assert.equal(scenario.taskSuccess.ci?.upper, 1);
    assert.equal(scenario.numeric.turns.meanDelta, -7);
    assert.equal(scenario.numeric.turns.ci?.lower, -7);
    assert.equal(scenario.numeric.turns.ci?.upper, -7);
    assert.equal(scenario.numeric.turns.pairs, 1);
    assert.equal(scenario.numeric.turns.cohensDz, null);
    assert.equal(scenario.recoverySuccess.knownPairs, 0);
    assert.equal(scenario.recoverySuccess.unknownBaseline, 1);
});

test('all-unknown baseline recovery stays explicit unknown, never zero', () => {
    const report = agent_eval_analysis_makeCorpusReport({
        seed: 2,
        scenarios: [agent_eval_analysis_makeScenarioReport({
            scenarioId: 'plain',
            trials: 2,
            runs: [
                agent_eval_analysis_makeRun({mode: 'program', trialIndex: 0}),
                agent_eval_analysis_makeRun({mode: 'program', trialIndex: 1}),
                agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex: 0, recoverySuccess: null}),
                agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex: 1, recoverySuccess: null}),
            ],
        })],
    });
    const analysis = analyzeAgentEvalCorpus(report);
    const recovery = analysis.overall.recoverySuccess;
    assert.equal(recovery.pairs, 2);
    assert.equal(recovery.knownPairs, 0);
    assert.equal(recovery.programKnown, 2);
    assert.equal(recovery.baselineKnown, 0);
    assert.equal(recovery.unknownProgram, 0);
    assert.equal(recovery.unknownBaseline, 2);
    assert.equal(recovery.delta, null);
    assert.equal(recovery.programRate, null);
    assert.equal(recovery.baselineRate, null);
    assert.equal(recovery.ci, null);
    assert.match(analysisToMarkdown(analysis), /unknown \(program 0, baseline 2\)/);
});

test('scenario-level analysis derives deterministic seeds per scenario and metric', () => {
    const scenario = agent_eval_analysis_makeScenarioReport({
        scenarioId: 'solo',
        trials: 2,
        runs: [
            agent_eval_analysis_makeRun({mode: 'program', trialIndex: 0, turns: 2}),
            agent_eval_analysis_makeRun({mode: 'program', trialIndex: 1, turns: 3}),
            agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex: 0, turns: 5}),
            agent_eval_analysis_makeRun({mode: 'react-baseline', trialIndex: 1, turns: 6}),
        ],
    });
    const trialSeeds = {solo: [11, 22]};
    const first = analyzeAgentEvalScenario(scenario, {seed: 7}, trialSeeds);
    const second = analyzeAgentEvalScenario(scenario, {seed: 7}, trialSeeds);
    assert.deepEqual(first, second);
    assert.equal(first.matchedPairs, 2);
    assert.equal(first.numeric.turns.meanDelta, -3);
    assert.ok(first.numeric.turns.ci);
    assert.notEqual(first.numeric.turns.ci.seed, first.taskSuccess.ci?.seed);
    assert.equal(
        analysisBootstrapSeed(7, 'solo', 'turns', 'numeric'),
        first.numeric.turns.ci?.seed,
    );
    assert.notEqual(analysisBootstrapSeed(7, 'solo', 'turns', 'numeric'),
        analysisBootstrapSeed(8, 'solo', 'turns', 'numeric'));
});

test('effect sizes: Cohen d_z for paired diffs and Cohen h for rates', () => {
    assert.equal(cohensDz([]), null);
    assert.equal(cohensDz([5]), null);
    assert.equal(cohensDz([1, 1, 1]), null);
    assert.ok(cohensDz([1, 2, 3]) !== null);
    closeTo(cohensDz([1, 2, 3]), 2);
    assert.equal(cohensH(0.5, 0.5), 0);
    closeTo(cohensH(1, 0), Math.PI);
    closeTo(cohensH(0.75, 0.25), 2 * (Math.asin(Math.sqrt(0.75)) - Math.asin(Math.sqrt(0.25))));
});

const closeTo = (actual: number | null, expected: number, tolerance = 1e-9): void => {
    assert.ok(actual !== null);
    assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${expected}, got ${actual}`);
};