import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentEvalRun} from '../../../../../../src/agent/execution/eval/contracts';
import type {AgentRunRequest, AgentRunResult} from '../../../../../../src/agent/execution/types';
import {
    agentEvalCorpusExitCode,
    runAgentEvalCorpus,
    serializeAgentEvalCorpusReport,
    toAgentEvalCorpusJson,
} from '../../../../../../src/agent/execution/eval/corpus';
import {deriveTrialSeed} from '../../../../../../src/agent/execution/eval/seed';
import type {AgentEvalScenarioReport} from '../../../../../../src/agent/execution/eval/harness';
import type {
    AgentFaultEvent,
    AgentFaultKind,
} from '../../../../../../src/agent/execution/eval/faults/contracts';
import {AgentFaultWorldError} from '../../../../../../src/agent/execution/eval/faults/contracts';
import {createAgentEvalFaultScenario} from '../../../../../../src/agent/execution/eval/faults/scenarios';
import {AGENT_FAULT_SCENARIO_ID_PREFIX} from '../../../../../../src/agent/execution/eval/faults/scenarios';
import {
    buildAgentFaultMatrix,
    type AgentFaultMatrixCell,
} from '../../../../../../src/agent/execution/eval/faults/matrix';
import {createFakeFaultWorld} from '../../../../../helpers/agent_fault_world';
import {createAgentFaultCorpus} from '../../../../../helpers/agent_fault_entries';
import {
    AGENT_FAULT_SIMULATED_MODEL,
    AGENT_FAULT_SIMULATED_PROVIDER,
} from '../../../../../../src/agent/execution/eval/faults/policy_runner';

const FAULT_SEED = 90210;
const FAULT_TRIALS = 2;

type FaultEvidence = Readonly<{
    faultKind: AgentFaultKind;
    trialIndex: number;
    trialSeed: number;
    baseValues: Record<string, string>;
    values: Record<string, string>;
    pageEpoch: number;
    events: readonly AgentFaultEvent[];
}>;

const runFaultCorpus = async () => runAgentEvalCorpus(
    createAgentFaultCorpus({backend: 'fixture', seed: FAULT_SEED, trials: FAULT_TRIALS}),
    {seed: FAULT_SEED},
);

const scenarioReport = (
    reports: readonly AgentEvalScenarioReport[],
    kind: AgentFaultKind,
): AgentEvalScenarioReport => {
    const found = reports.find((candidate) => candidate.scenario.id === `${AGENT_FAULT_SCENARIO_ID_PREFIX}${kind}`);
    if (!found) {
        throw new Error(`missing fault scenario report: ${kind}`);
    }
    return found;
};

const evidenceOf = (run: AgentEvalRun): FaultEvidence => run.verification.evidence as FaultEvidence;

const cell = (
    kind: AgentFaultKind,
    mode: AgentFaultMatrixCell['mode'],
    cells: readonly AgentFaultMatrixCell[],
): AgentFaultMatrixCell => {
    const found = cells.find((candidate) => candidate.faultKind === kind && candidate.mode === mode);
    if (!found) {
        throw new Error(`missing matrix cell ${kind}/${mode}`);
    }
    return found;
};

test('fault corpus executes all seven fault kinds in both modes against the external verifier', async () => {
    const report = await runFaultCorpus();
    assert.deepEqual(report.corpus.scenarioIds, [
        'fault-mutation-report-error',
        'fault-revision-drift',
        'fault-epoch-navigation',
        'fault-transactional-restore',
        'fault-compensation-partial-restore',
        'fault-external-mutation-conflict',
        'fault-ambiguous-timeout',
    ]);
    assert.equal(agentEvalCorpusExitCode(report), 0);
    assert.equal(report.corpus.seed, FAULT_SEED);
    assert.equal(report.aggregates.program?.taskSuccess.rate, 1);
    assert.equal(report.aggregates['react-baseline']?.taskSuccess.rate, 1);
    for (const scenario of report.reports) {
        for (const mode of ['program', 'react-baseline'] as const) {
            const runs = scenario.runs[mode];
            assert.equal(runs?.length, FAULT_TRIALS, `${scenario.scenario.id}/${mode}`);
            for (const run of runs ?? []) {
                const evidence = evidenceOf(run);
                assert.equal(evidence.trialSeed, deriveTrialSeed(FAULT_SEED, scenario.scenario.id, run.trialIndex));
                assert.equal(evidence.faultKind, scenario.scenario.id.slice(AGENT_FAULT_SCENARIO_ID_PREFIX.length));
                assert.ok(evidence.events.length > 0, 'external verifier requires observed transitions');
            }
        }
    }
});

test('program-first journals retained transaction state per fault kind', async () => {
    const report = await runFaultCorpus();
    const effectsOf = (kind: AgentFaultKind, trial = 0) => scenarioReport(report.reports, kind)
        .runs.program?.[trial]?.result.programs?.[0]?.effects;

    assert.deepEqual(effectsOf('mutation-report-error')?.map((effect) => [effect.stepName, effect.status]), [
        ['browser.fill', 'failed'],
        ['browser.click', 'succeeded'],
    ]);
    assert.deepEqual(effectsOf('revision-drift')?.map((effect) => [effect.stepName, effect.status]), [
        ['browser.fill', 'failed'],
        ['browser.fill', 'succeeded'],
    ]);
    const nav = effectsOf('epoch-navigation') ?? [];
    assert.deepEqual(nav.map((effect) => [effect.worldBefore.pageEpoch, effect.worldAfter.pageEpoch]), [
        ['epoch-1', 'epoch-2'],
        ['epoch-2', 'epoch-2'],
    ]);
    assert.deepEqual(effectsOf('transactional-restore')?.map((effect) => [effect.stepName, effect.status, effect.compensates]), [
        ['browser.fill', 'failed', undefined],
        ['debug.compensate', 'succeeded', 1],
    ]);
    assert.deepEqual(effectsOf('compensation-partial-restore')?.map((effect) => [effect.stepName, effect.status, effect.compensates]), [
        ['browser.fill', 'failed', undefined],
        ['debug.compensate', 'failed', 1],
        ['debug.compensate', 'succeeded', 1],
    ]);
    assert.deepEqual(effectsOf('external-mutation-conflict')?.map((effect) => effect.status), ['failed', 'succeeded']);
    assert.equal(
        scenarioReport(report.reports, 'external-mutation-conflict').runs.program?.[0]?.result.programs?.[0]?.text,
        'transactional-conflicts:1',
    );
    assert.deepEqual(effectsOf('ambiguous-timeout', 0)?.map((effect) => effect.status), ['failed']);
    assert.deepEqual(effectsOf('ambiguous-timeout', 1)?.map((effect) => [effect.stepName, effect.status]), [
        ['browser.fill', 'failed'],
        ['browser.fill', 'succeeded'],
    ]);
});

test('react-baseline journal metrics stay explicitly unknown, never zero', async () => {
    const report = await runFaultCorpus();
    for (const scenario of report.reports) {
        for (const run of scenario.runs['react-baseline'] ?? []) {
            assert.equal(run.metrics.effects.availability, 'not-exposed');
            assert.equal(run.metrics.effects.worldEffectCalls, null);
            assert.equal(run.metrics.effects.failedWorldChangingEffects, null);
            assert.equal(run.metrics.effects.compensationEffects, null);
            assert.equal(run.metrics.recoverySuccess, null);
            assert.equal(run.result.programs, undefined);
        }
    }
});

test('research distinction: transactional restore versus ad-hoc re-issue, replay forbidden', async () => {
    const report = await runFaultCorpus();
    const matrix = buildAgentFaultMatrix(report.reports);

    for (const kind of [
        'mutation-report-error',
        'revision-drift',
        'epoch-navigation',
        'transactional-restore',
        'compensation-partial-restore',
        'external-mutation-conflict',
        'ambiguous-timeout',
    ] as const) {
        assert.equal(cell(kind, 'program', matrix.cells).postRewindReplayEffects, 0, `${kind} program replay`);
        assert.equal(cell(kind, 'react-baseline', matrix.cells).postRewindReplayEffects, 0, `${kind} baseline replay`);
        assert.equal(cell(kind, 'program', matrix.cells).redundantAppliedEffects, 0, `${kind} program redundant`);
        assert.equal(cell(kind, 'program', matrix.cells).taskSuccessRate, 1);
        assert.equal(cell(kind, 'program', matrix.cells).faultRecoveryRate, 1);
        assert.equal(cell(kind, 'react-baseline', matrix.cells).taskSuccessRate, 1);
        assert.equal(cell(kind, 'react-baseline', matrix.cells).journalRecovery, 'unknown');
    }

    const programRestore = cell('transactional-restore', 'program', matrix.cells);
    assert.equal(programRestore.transactionalCompensations, 2);
    assert.equal(programRestore.adHocRestores, 0);
    assert.equal(programRestore.failedWorldChangingEffects, 2);
    assert.equal(programRestore.postErrorEffectCalls, 0);
    const baselineRestore = cell('transactional-restore', 'react-baseline', matrix.cells);
    assert.equal(baselineRestore.transactionalCompensations, 'unknown');
    assert.equal(baselineRestore.adHocRestores, 2, 'baseline restores by issuing new ad-hoc effects');
    assert.equal(baselineRestore.failedWorldChangingEffects, 'unknown');

    const programPartial = cell('compensation-partial-restore', 'program', matrix.cells);
    assert.equal(programPartial.transactionalCompensations, 4, 'failed attempt stays journal-linked to the same failure');
    assert.equal(programPartial.adHocRestores, 0);
    assert.equal(programPartial.faultRecoveryRate, 1);
    const baselinePartial = cell('compensation-partial-restore', 'react-baseline', matrix.cells);
    assert.equal(baselinePartial.adHocRestores, 2);
    assert.ok(baselinePartial.postErrorEffectCalls > programPartial.postErrorEffectCalls);

    assert.equal(cell('mutation-report-error', 'react-baseline', matrix.cells).redundantAppliedEffects, 2,
        'blind retry after an applied-but-reported failure re-writes a value the world already held');
    assert.equal(cell('ambiguous-timeout', 'react-baseline', matrix.cells).redundantAppliedEffects, 1,
        'only the applied trial makes the blind retry redundant');

    assert.equal(cell('external-mutation-conflict', 'program', matrix.cells).conflictsDetected, 2);
    assert.equal(cell('external-mutation-conflict', 'react-baseline', matrix.cells).conflictsDetected, 0,
        'an agent without compare-and-set cannot even formulate the revision conflict');
});

test('committed journal-only recovery heuristic misjudges ambiguous faults; the fault matrix does not', async () => {
    const report = await runFaultCorpus();
    const program = (kind: AgentFaultKind, trial = 0) => scenarioReport(report.reports, kind).runs.program?.[trial];
    assert.equal(program('mutation-report-error')?.metrics.recoverySuccess, false);
    assert.equal(program('transactional-restore')?.metrics.recoverySuccess, true);
    assert.equal(program('compensation-partial-restore')?.metrics.recoverySuccess, true);
    assert.equal(program('external-mutation-conflict')?.metrics.recoverySuccess, false);
    assert.equal(program('ambiguous-timeout', 0)?.metrics.recoverySuccess, false);
    assert.equal(program('ambiguous-timeout', 1)?.metrics.recoverySuccess, true);
    const matrix = buildAgentFaultMatrix(report.reports);
    assert.equal(cell('mutation-report-error', 'program', matrix.cells).faultRecoveryRate, 1);
    assert.equal(cell('ambiguous-timeout', 'program', matrix.cells).faultRecoveryRate, 1);
});

test('fault corpus trials are deterministic per seed', async () => {
    const first = await runFaultCorpus();
    const second = await runFaultCorpus();
    assert.equal(toAgentEvalCorpusJson(first), toAgentEvalCorpusJson(second));
    assert.equal(serializeAgentEvalCorpusReport(first), serializeAgentEvalCorpusReport(second));
    assert.deepEqual(first.trialSeeds['fault-ambiguous-timeout'], [
        deriveTrialSeed(FAULT_SEED, 'fault-ambiguous-timeout', 0),
        deriveTrialSeed(FAULT_SEED, 'fault-ambiguous-timeout', 1),
    ]);
});

test('external verifier rejects a fabricated program journal that never touched the world', async () => {
    const world = createFakeFaultWorld();
    const scenario = createAgentEvalFaultScenario({
        kind: 'mutation-report-error',
        provider: 'liar',
        model: 'fabricated-journal',
        world: () => world,
        seed: 7,
        modes: ['program'],
    });
    const liarRunner = {
        run: async (request: AgentRunRequest): Promise<AgentRunResult> => ({
            provider: request.provider,
            model: request.model,
            text: 'fill applied and compensation journaled',
            executionMode: 'program',
            trace: {
                metrics: {
                    turns: 2, toolCalls: 0, readCalls: 0, controlCalls: 0,
                    effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0,
                },
                tools: [],
            },
            programs: [{
                source: 'fabricated',
                input: {},
                status: 'completed',
                effects: [{
                    sequence: 1,
                    stepName: 'browser.fill',
                    status: 'succeeded',
                    worldBefore: {pageEpoch: 'epoch-1', captureRevision: 1},
                    worldAfter: {pageEpoch: 'epoch-1', captureRevision: 2},
                }],
            }],
        }),
    };
    const report = await runAgentEvalCorpus({
        id: 'fault-liar-corpus',
        version: 1,
        entries: [{scenario, runner: liarRunner}],
    }, {seed: 7});
    const run = report.reports[0]?.runs.program?.[0];
    assert.ok(run);
    assert.equal(run.success, false);
    assert.equal(world.revision(), 1, 'only the prepare load touched the world');
});

test('unlinked ad-hoc restore passes the task but is attributed as baseline-style recovery', async () => {
    const world = createFakeFaultWorld();
    const scenario = createAgentEvalFaultScenario({
        kind: 'transactional-restore',
        provider: AGENT_FAULT_SIMULATED_PROVIDER,
        model: 'program-claiming-no-journal',
        world: () => world,
        seed: 11,
        modes: ['program'],
    });
    const fakeProgramRunner = {
        run: async (request: AgentRunRequest): Promise<AgentRunResult> => {
            const previous = (await world.read(world.field('name'))) ?? '';
            await assert.rejects(
                () => world.fill(world.field('name'), 'Alice'),
                AgentFaultWorldError,
            );
            await world.fill(world.refresh('name'), previous);
            return {
                provider: request.provider,
                model: request.model,
                text: 'restored, trust me',
                executionMode: 'program',
                trace: {
                    metrics: {
                        turns: 2, toolCalls: 0, readCalls: 0, controlCalls: 0,
                        effectCalls: 0, failedToolCalls: 0, postErrorEffectCalls: 0,
                    },
                    tools: [],
                },
                programs: [{source: 'no-link', input: {}, status: 'completed', effects: []}],
            };
        },
    };
    const report = await runAgentEvalCorpus({
        id: 'fault-unlinked-restore',
        version: 1,
        entries: [{scenario, runner: fakeProgramRunner}],
    }, {seed: 11, trials: 1});
    const run = report.reports[0]?.runs.program?.[0];
    assert.ok(run);
    assert.equal(run.success, true, 'the world really is restored, so the task passes');
    const matrix = buildAgentFaultMatrix(report.reports);
    const programCell = cell('transactional-restore', 'program', matrix.cells);
    assert.equal(programCell.transactionalCompensations, 0, 'no journal link means no transactional compensation');
    assert.equal(programCell.adHocRestores, 1, 'the restore is attributed to an ad-hoc re-issue');
});
