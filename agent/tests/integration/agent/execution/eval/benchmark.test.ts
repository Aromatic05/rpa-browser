import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentEvalCorpus, toAgentEvalCorpusJson} from '../../../../../src/agent/execution/eval/corpus';
import {createAgentEvalBenchmarkScenario} from '../../../../../src/agent/execution/eval/benchmark';
import {deriveTrialSeed} from '../../../../../src/agent/execution/eval/seed';
import {createFakeAgentEvalWorld} from '../../../../helpers/agent_eval_fake_world';
import {createAgentEvalBenchmarkCorpus} from '../../../../helpers/agent_eval_entries';
import {AGENT_EVAL_SIMULATED_MODEL, AGENT_EVAL_SIMULATED_PROVIDER} from '../../../../helpers/agent_eval_sim_runner';

const BENCHMARK_SEED = 4242;
const BENCHMARK_TRIALS = 2;

const runBenchmark = () => runAgentEvalCorpus(
    createAgentEvalBenchmarkCorpus({backend: 'fixture', seed: BENCHMARK_SEED, trials: BENCHMARK_TRIALS}),
    {seed: BENCHMARK_SEED},
);

const scenarioReport = (
    report: Awaited<ReturnType<typeof runBenchmark>>,
    scenarioId: string,
) => {
    const found = report.reports.find((candidate) => candidate.scenario.id === scenarioId);
    if (!found) {
        throw new Error(`missing scenario report: ${scenarioId}`);
    }
    return found;
};

test('benchmark corpus covers all five scenario categories in both modes', async () => {
    const report = await runBenchmark();
    assert.deepEqual(report.corpus.scenarioIds, [
        'form-fill-submit',
        'failed-mutation-recovery',
        'side-effect-compensation',
        'drift-stale-target',
        'multi-step-order',
    ]);
    assert.equal(report.corpus.seed, BENCHMARK_SEED);
    assert.deepEqual(report.corpus.models, [{
        provider: AGENT_EVAL_SIMULATED_PROVIDER,
        model: AGENT_EVAL_SIMULATED_MODEL,
        scenarioIds: report.corpus.scenarioIds,
    }]);
    assert.equal(report.aggregates.program?.taskSuccess.rate, 1);
    assert.equal(report.aggregates['react-baseline']?.taskSuccess.rate, 1);
    assert.equal(
        toAgentEvalCorpusJson(report).includes('durationMs'),
        false,
        'deterministic serialization must omit wall-clock latency',
    );
});

test('ordinary form task verifies externally and keeps baseline world metrics unknown', async () => {
    const report = await runBenchmark();
    const scenario = scenarioReport(report, 'form-fill-submit');
    const program = scenario.runs.program?.[0];
    const baseline = scenario.runs['react-baseline']?.[0];
    assert.ok(program && baseline);
    assert.equal(program.success, true);
    assert.equal(program.metrics.effects.availability, 'program-journal');
    assert.equal(program.metrics.effects.worldEffectCalls, 2);
    assert.equal(program.metrics.effects.failedWorldChangingEffects, 0);
    assert.equal(program.metrics.effects.compensationEffects, 0);
    assert.deepEqual(
        program.result.programs?.[0]?.effects?.map((effect) => effect.status),
        ['succeeded', 'succeeded'],
    );
    assert.equal(baseline.success, true);
    assert.equal(baseline.metrics.effects.availability, 'not-exposed');
    assert.equal(baseline.metrics.effects.worldEffectCalls, null);
    assert.equal(baseline.metrics.effects.failedWorldChangingEffects, null);
    assert.equal(baseline.metrics.recoverySuccess, null);
    assert.equal(baseline.metrics.effects.toolEffectCalls, 2);
});

test('recoverable failed mutation recovers in both modes', async () => {
    const report = await runBenchmark();
    const scenario = scenarioReport(report, 'failed-mutation-recovery');
    const program = scenario.runs.program?.[0];
    const baseline = scenario.runs['react-baseline']?.[0];
    assert.ok(program && baseline);
    assert.equal(program.success, true);
    assert.equal(program.metrics.recoverySuccess, true);
    assert.equal(program.metrics.effects.failedWorldChangingEffects, 0);
    assert.equal(baseline.success, true);
    assert.equal(baseline.metrics.failedToolCalls, 1);
    assert.equal(baseline.metrics.taskSuccess, true);
});

test('side-effect-on-error compensation is journaled for program mode only', async () => {
    const report = await runBenchmark();
    const scenario = scenarioReport(report, 'side-effect-compensation');
    const program = scenario.runs.program?.[0];
    const baseline = scenario.runs['react-baseline']?.[0];
    assert.ok(program && baseline);
    assert.equal(program.success, true);
    assert.equal(program.metrics.effects.failedWorldChangingEffects, 1);
    assert.equal(program.metrics.effects.compensationEffects, 1);
    assert.equal(program.metrics.recoverySuccess, true);
    assert.deepEqual(
        program.result.programs?.[0]?.effects?.map((effect) => effect.compensates),
        [undefined, 1],
    );
    assert.equal(baseline.success, true);
    assert.equal(baseline.metrics.effects.failedWorldChangingEffects, null);
    assert.equal(baseline.metrics.effects.compensationEffects, null);
    assert.equal(baseline.metrics.postErrorEffectCalls, 1);
});

test('drift/stale target recovery rebinds the target and completes', async () => {
    const report = await runBenchmark();
    const scenario = scenarioReport(report, 'drift-stale-target');
    const program = scenario.runs.program?.[0];
    const baseline = scenario.runs['react-baseline']?.[0];
    assert.ok(program && baseline);
    assert.equal(program.success, true);
    assert.equal(program.metrics.repair.refreshCalls, 1);
    assert.equal(program.metrics.effects.failedWorldChangingEffects, 0);
    assert.equal(baseline.success, true);
    assert.equal(baseline.metrics.failedToolCalls, 1);
    assert.equal(baseline.metrics.readCalls, 2);
    assert.equal(baseline.metrics.recoverySuccess, null);
});

test('multi-step task records distributions across repeated trials', async () => {
    const report = await runBenchmark();
    const scenario = scenarioReport(report, 'multi-step-order');
    assert.equal(scenario.runs.program?.length, scenario.scenario.trials);
    const trials = scenario.scenario.trials;
    assert.equal(report.aggregates['react-baseline']?.trials, trials * 5);
    assert.equal(scenario.aggregates['react-baseline']?.turns.count, trials);
    assert.equal(scenario.aggregates['react-baseline']?.toolCalls.min, 4);
    assert.equal(scenario.aggregates.program?.effectCalls.mean, 0);
    const program = scenario.runs.program?.[0];
    assert.equal(program?.result.programs?.[0]?.effects?.length, 3);
});

test('trial seeds are derived deterministically per scenario and trial', async () => {
    const report = await runBenchmark();
    assert.deepEqual(report.trialSeeds['form-fill-submit'], [
        deriveTrialSeed(BENCHMARK_SEED, 'form-fill-submit', 0),
        deriveTrialSeed(BENCHMARK_SEED, 'form-fill-submit', 1),
    ]);
    const repeated = await runBenchmark();
    assert.deepEqual(report.trialSeeds, repeated.trialSeeds);
});

test('external verifier fails a runner that self-reports success without touching the world', async () => {
    const world = createFakeAgentEvalWorld();
    const scenario = createAgentEvalBenchmarkScenario({
        kind: 'form-fill-submit',
        provider: 'liar',
        model: 'self-report',
        world: () => world,
        seed: 1,
        modes: ['program'],
    });
    const report = await runAgentEvalCorpus({
        id: 'liar-corpus',
        version: 1,
        entries: [{
            scenario,
            runner: {
                run: async (request) => ({
                    provider: request.provider,
                    model: request.model,
                    text: 'Absolutely done, the form is filled and submitted.',
                    trace: {
                        metrics: {
                            turns: 1, toolCalls: 0, readCalls: 0, controlCalls: 0,
                            effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0,
                        },
                        tools: [],
                    },
                }),
            },
        }],
    }, {seed: 1});
    const run = report.reports[0]?.runs.program?.[0];
    assert.ok(run);
    assert.equal(run.success, false);
    assert.equal(run.metrics.taskSuccess, false);
    assert.deepEqual(run.verification.evidence, {
        values: {name: 'Before', result: ''},
        fixture: 'benchmark-form',
    });
    assert.equal(world.revision(), 1, 'only the prepare load touched the world');
});
