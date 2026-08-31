import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeAgentEvalCorpus} from '../../../../../../src/agent/execution/eval/analysis/analyze';
import {analysisToMarkdown, analysisToStableJson} from '../../../../../../src/agent/execution/eval/analysis/render';
import {AGENT_FAULT_KINDS} from '../../../../../../src/agent/execution/eval/faults/contracts';
import {
    agent_eval_analysis_faultCorpusReport,
    agent_eval_analysis_makeCorpusReport,
    agent_eval_analysis_makeRun,
    agent_eval_analysis_makeScenarioReport,
} from '../../../../../helpers/agent_eval_analysis_fixtures';
import type {AgentEvalCorpusReport} from '../../../../../../src/agent/execution/eval/corpus';

test('fault semantic-oracle corpus: react-baseline journal metrics stay unknown, never zero', async () => {
    const report = await agent_eval_analysis_faultCorpusReport();
    const analysis = analyzeAgentEvalCorpus(report);
    assert.equal(analysis.pairing.scenarios, AGENT_FAULT_KINDS.length);
    assert.equal(analysis.pairing.matchedPairs, AGENT_FAULT_KINDS.length * 2);
    assert.equal(analysis.pairing.unmatchedProgram.length, 0);
    assert.equal(analysis.pairing.unmatchedBaseline.length, 0);

    for (const scenario of analysis.scenarios) {
        for (const key of ['failedWorldChangingEffects', 'compensationEffects', 'worldEffectCalls'] as const) {
            const journal = scenario.journal[key];
            assert.ok(journal.programObservable > 0, `${scenario.scenarioId}/${key} program observable`);
            assert.equal(journal.baselineObservable, 0, `${scenario.scenarioId}/${key} baseline stays unknown`);
            assert.equal(journal.pairs, 0);
            assert.equal(journal.meanDelta, null);
            assert.equal(journal.ci, null);
            assert.equal(journal.unknown, true);
            assert.ok(journal.programMean !== null);
            assert.equal(journal.baselineMean, null);
        }
        assert.equal(scenario.recoverySuccess.unknownBaseline, 0,
            `${scenario.scenarioId} baseline recovery attributed from the external oracle, not a journal`);
        assert.equal(scenario.recoverySuccess.knownPairs, 2);
    }

    const overall = analysis.overall;
    assert.equal(overall.recoverySuccess.unknownBaseline, 0);
    assert.equal(overall.recoverySuccess.programRate, 1,
        'oracle recovery supersedes the journal-only heuristic that mislabels ambiguous faults');
    assert.ok(overall.recoverySuccess.delta !== null);
    assert.ok(overall.journal.failedWorldChangingEffects.unknown);
    assert.equal(overall.journal.failedWorldChangingEffects.baselineObservable, 0);
    assert.equal(overall.journal.compensationEffects.baselineObservable, 0);
    assert.equal(overall.journal.worldEffectCalls.baselineObservable, 0);
});

test('fault oracle analysis renders unknowns and the oracle distinction deterministically', async () => {
    const report = await agent_eval_analysis_faultCorpusReport();
    const first = analyzeAgentEvalCorpus(report);
    const second = analyzeAgentEvalCorpus(report);
    assert.deepEqual(first, second);
    const markdown = analysisToMarkdown(first);
    assert.match(markdown, /fault-transactional-restore/);
    assert.match(markdown, /fault-mutation-report-error/);
    assert.ok(analysisToStableJson(first) === analysisToStableJson(second));
});

test('non-fault evidence keeps baseline recovery unknown while journal metrics stay exposed for program', () => {
    const report: AgentEvalCorpusReport = agent_eval_analysis_makeCorpusReport({
        seed: 3,
        scenarios: [agent_eval_analysis_makeScenarioReport({
            scenarioId: 'plain',
            trials: 1,
            runs: [
                agent_eval_analysis_makeRun({
                    mode: 'program',
                    trialIndex: 0,
                    recoverySuccess: true,
                    failedWorldChangingEffects: 1,
                    compensationEffects: 1,
                    worldEffectCalls: 2,
                }),
                agent_eval_analysis_makeRun({
                    mode: 'react-baseline',
                    trialIndex: 0,
                    recoverySuccess: null,
                }),
            ],
        })],
    });
    const analysis = analyzeAgentEvalCorpus(report);
    const scenario = analysis.scenarios[0];
    assert.equal(scenario.journal.failedWorldChangingEffects.programObservable, 1);
    assert.equal(scenario.journal.failedWorldChangingEffects.baselineObservable, 0);
    assert.equal(scenario.journal.failedWorldChangingEffects.unknown, true);
    assert.equal(scenario.recoverySuccess.unknownBaseline, 1);
    assert.equal(scenario.recoverySuccess.knownPairs, 0);
    assert.equal(scenario.recoverySuccess.delta, null);
});