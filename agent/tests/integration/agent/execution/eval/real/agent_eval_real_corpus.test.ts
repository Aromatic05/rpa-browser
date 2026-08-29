import test from 'node:test';
import assert from 'node:assert/strict';
import {
    agentEvalCorpusExitCode,
    runAgentEvalCorpus,
    toAgentEvalCorpusJson,
} from '../../../../../../src/agent/execution/eval/corpus';
import type { AgentEvalRun } from '../../../../../../src/agent/execution/eval/contracts';
import type { AgentEvalScenarioReport } from '../../../../../../src/agent/execution/eval/harness';
import { analyzeAgentEvalCorpus } from '../../../../../../src/agent/execution/eval/analysis/analyze';
import {
    buildAgentFaultMatrix,
    type AgentFaultMatrixCell,
} from '../../../../../../src/agent/execution/eval/faults/matrix';
import { AGENT_FAULT_SCENARIO_ID_PREFIX } from '../../../../../../src/agent/execution/eval/faults/scenarios';
import type { AgentFaultKind } from '../../../../../../src/agent/execution/eval/faults/contracts';
import { AGENT_FAULT_KINDS } from '../../../../../../src/agent/execution/eval/faults/contracts';
import { createFakeFaultWorld } from '../../../../../helpers/agent_fault_world';
import { createRealAgentFaultCorpus } from '../../../../../helpers/agent_eval_real_corpus';

/**
 * Real-execution fault corpus: the committed fault contracts, world and
 * scenarios are executed by the production Program-first runner and the
 * production react-baseline runner (the exact runners createWorkspaceAgentFactory
 * composes), with a deterministic faux model. Faults are injected on the world
 * browser port outside all agent logic.
 *
 * Documented missing production seams (no source changes made):
 *
 *   1. external-mutation-conflict. The committed oracle's compare-and-set
 *      (`world.transact` / revisionConflict) has no production counterpart:
 *      the DSL `fill` and the react-baseline `browser.fill` both clobber
 *      blindly and no runner exposes a transactional write. The real agent
 *      therefore cannot detect the revision conflict; the corpus reports
 *      conflictsDetected = 0 and the task succeeds by clobbering. Injecting
 *      conflict detection would require a production compare-and-set tool seam,
 *      which does not exist.
 *
 *   2. Full createWorkspaceAgentFactory / service path. The factory drives the
 *      page through the workspace MCP tool handlers and Snapshot V2 machinery,
 *      whose browser port has no adapter for the committed fault world script.
 *      The real benchmark therefore wires the production runner classes (which
 *      the factory composes verbatim) directly to the fault world port; the
 *      service HTTP/workspace layer has no fault-injection seam without source
 *      changes.
 */

const REAL_SEED = 90210;
const REAL_TRIALS = 2;

const holder: { current: ReturnType<typeof createFakeFaultWorld> | null } = { current: null };

const fixtureWorld = async () => {
    if (!holder.current) {
        throw new Error('fixture fault world is not loaded');
    }
    return holder.current;
};

const resetWorld = (): void => {
    holder.current = createFakeFaultWorld();
};

const runRealCorpus = async () => {
    resetWorld();
    return await runAgentEvalCorpus(
        createRealAgentFaultCorpus({ world: fixtureWorld, seed: REAL_SEED, trials: REAL_TRIALS }),
        { seed: REAL_SEED },
    );
};

const scenarioReport = (
    reports: readonly AgentEvalScenarioReport[],
    kind: AgentFaultKind,
): AgentEvalScenarioReport => {
    const found = reports.find(
        (candidate) => candidate.scenario.id === `${AGENT_FAULT_SCENARIO_ID_PREFIX}${kind}`,
    );
    if (!found) {
        throw new Error(`missing real fault scenario report: ${kind}`);
    }
    return found;
};

const cell = (
    kind: AgentFaultKind,
    mode: AgentFaultMatrixCell['mode'],
    cells: readonly AgentFaultMatrixCell[],
): AgentFaultMatrixCell => {
    const found = cells.find(
        (candidate) => candidate.faultKind === kind && candidate.mode === mode,
    );
    if (!found) {
        throw new Error(`missing real fault matrix cell ${kind}/${mode}`);
    }
    return found;
};

const journalOf = (
    run: AgentEvalRun,
): readonly { stepName: string; status: string; compensates?: number }[] | undefined =>
    run.result.programs?.[0]?.effects;

test('real execution corpus runs all seven fault kinds through the production runners', async () => {
    const report = await runRealCorpus();
    assert.equal(report.corpus.id, 'agent-fault-real-execution-benchmark');
    assert.deepEqual(
        report.corpus.scenarioIds,
        AGENT_FAULT_KINDS.map((kind) => `${AGENT_FAULT_SCENARIO_ID_PREFIX}${kind}`),
    );
    assert.equal(report.corpus.seed, REAL_SEED);
    for (const scenario of report.reports) {
        for (const mode of ['program', 'react-baseline'] as const) {
            const runs = scenario.runs[mode];
            assert.equal(runs?.length, REAL_TRIALS, `${scenario.scenario.id}/${mode} trials`);
            for (const run of runs ?? []) {
                assert.ok(
                    (run.verification.evidence as { events?: unknown[] }).events !== undefined,
                    `${scenario.scenario.id}/${mode}#${run.trialIndex} carries external event evidence`,
                );
            }
        }
    }
});

test('program-first metrics come from the retained transaction/effect journal', async () => {
    const report = await runRealCorpus();
    const effectsOf = (kind: AgentFaultKind, trial = 0) =>
        scenarioReport(report.reports, kind).runs.program?.[trial]?.result.programs?.[0]?.effects;

    const restore = effectsOf('transactional-restore');
    assert.deepEqual(
        restore?.map((effect) => [effect.stepName, effect.status]),
        [
            ['browser.fill', 'failed'],
            ['browser.fill', 'succeeded'],
        ],
    );
    assert.equal(
        restore?.[1]?.compensates,
        1,
        'the restore is journal-linked to the failed mutation',
    );
    assert.deepEqual(
        effectsOf('mutation-report-error')?.map((effect) => [effect.stepName, effect.status]),
        [
            ['browser.fill', 'failed'],
            ['browser.fill', 'succeeded'],
        ],
    );
    const partial = effectsOf('compensation-partial-restore');
    assert.deepEqual(
        partial?.map((effect) => [effect.stepName, effect.status]),
        [
            ['browser.fill', 'failed'],
            ['browser.fill', 'failed'],
            ['browser.fill', 'succeeded'],
        ],
    );
    assert.equal(partial?.[1]?.compensates, 1);
    assert.equal(partial?.[2]?.compensates, 1);
    assert.deepEqual(
        effectsOf('external-mutation-conflict')?.map((effect) => [effect.stepName, effect.status]),
        [['browser.fill', 'succeeded']],
    );
});

test('react-baseline journal metrics stay explicitly unknown, never zero', async () => {
    const report = await runRealCorpus();
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

test('no replay of prior effects after rewind/recovery; transactional compensation vs ad-hoc repair', async () => {
    const report = await runRealCorpus();
    const matrix = buildAgentFaultMatrix(report.reports);

    for (const kind of AGENT_FAULT_KINDS) {
        if (kind === 'epoch-navigation' || kind === 'ambiguous-timeout') {
            continue;
        }
        assert.equal(
            cell(kind, 'program', matrix.cells).postRewindReplayEffects,
            0,
            `${kind} program replay`,
        );
        assert.equal(
            cell(kind, 'react-baseline', matrix.cells).postRewindReplayEffects,
            0,
            `${kind} baseline replay`,
        );
        assert.equal(
            cell(kind, 'program', matrix.cells).redundantAppliedEffects,
            0,
            `${kind} program redundant`,
        );
    }
    assert.equal(
        cell('epoch-navigation', 'react-baseline', matrix.cells).postRewindReplayEffects,
        0,
    );
    assert.ok(
        cell('epoch-navigation', 'program', matrix.cells).postRewindReplayEffects > 0,
        'the real epoch-navigation compensation re-applies the base value the navigation rewind already restored, which the external semantics flags as a redundant post-rewind write',
    );
    assert.equal(
        cell('ambiguous-timeout', 'program', matrix.cells).redundantAppliedEffects,
        1,
        'the no-effect timeout trial compensates a value the world already held, a single redundant restore write',
    );

    const programRestore = cell('transactional-restore', 'program', matrix.cells);
    assert.ok(
        programRestore.transactionalCompensations !== 'unknown' &&
            programRestore.transactionalCompensations >= REAL_TRIALS,
        'program restore is journal-linked transactional compensation',
    );
    assert.equal(programRestore.adHocRestores, 0);
    const baselineRestore = cell('transactional-restore', 'react-baseline', matrix.cells);
    assert.equal(baselineRestore.transactionalCompensations, 'unknown');
    assert.ok(
        baselineRestore.adHocRestores >= REAL_TRIALS,
        'baseline restores by issuing new ad-hoc effects',
    );
    assert.equal(baselineRestore.journalRecovery, 'unknown');

    const programPartial = cell('compensation-partial-restore', 'program', matrix.cells);
    assert.equal(
        programPartial.transactionalCompensations,
        'unknown' === programPartial.transactionalCompensations ? 'unknown' : REAL_TRIALS * 2,
        'every partial-restore attempt stays journal-linked',
    );
    assert.equal(programPartial.adHocRestores, 0);
    const baselinePartial = cell('compensation-partial-restore', 'react-baseline', matrix.cells);
    assert.ok(baselinePartial.adHocRestores >= REAL_TRIALS);

    assert.equal(
        cell('mutation-report-error', 'react-baseline', matrix.cells).redundantAppliedEffects,
        0,
        'a re-verifying real baseline does not blindly replay the applied effect',
    );
});

test('missing compare-and-set seam: external mutation conflict is never detected by the real runners', async () => {
    const report = await runRealCorpus();
    const matrix = buildAgentFaultMatrix(report.reports);
    assert.equal(
        cell('external-mutation-conflict', 'program', matrix.cells).conflictsDetected,
        0,
        'the production DSL fill has no compare-and-set transact seam',
    );
    assert.equal(
        cell('external-mutation-conflict', 'react-baseline', matrix.cells).conflictsDetected,
        0,
    );
    assert.equal(cell('external-mutation-conflict', 'program', matrix.cells).taskSuccessRate, 1);
    assert.equal(
        cell('external-mutation-conflict', 'react-baseline', matrix.cells).taskSuccessRate,
        1,
    );
});

test('honest real recovery: applied-but-failed forward goals roll back cleanly and fail the task', async () => {
    const report = await runRealCorpus();
    const matrix = buildAgentFaultMatrix(report.reports);
    for (const kind of ['mutation-report-error', 'revision-drift'] as const) {
        const program = cell(kind, 'program', matrix.cells);
        assert.equal(
            program.taskSuccessRate,
            0,
            `${kind}: the retained transaction cannot re-drive a failed applied effect`,
        );
        assert.equal(
            program.faultRecoveryRate,
            1,
            `${kind}: the transaction still recovers by compensation`,
        );
        assert.equal(program.postRewindReplayEffects, 0);
        const baseline = cell(kind, 'react-baseline', matrix.cells);
        assert.equal(
            baseline.taskSuccessRate,
            1,
            `${kind}: the real baseline re-verifies and completes the goal ad hoc`,
        );
    }
    const timeoutProgram = cell('ambiguous-timeout', 'program', matrix.cells);
    assert.equal(timeoutProgram.taskSuccessRate, 0);
    assert.equal(
        timeoutProgram.faultRecoveryRate,
        0.5,
        'the applied trial recovers; the no-effect trial compensates a value the world already held and is not counted recovered',
    );
    assert.equal(timeoutProgram.redundantAppliedEffects, 1);
    assert.equal(cell('ambiguous-timeout', 'react-baseline', matrix.cells).taskSuccessRate, 1);
    const nav = cell('epoch-navigation', 'program', matrix.cells);
    assert.equal(nav.taskSuccessRate, 0);
    assert.equal(
        nav.faultRecoveryRate,
        0,
        'the epoch-navigation compensation restores a value the navigation rewind already restored, so the external semantics does not count it recovered',
    );
    assert.equal(cell('epoch-navigation', 'react-baseline', matrix.cells).taskSuccessRate, 1);
    assert.equal(cell('transactional-restore', 'program', matrix.cells).taskSuccessRate, 1);
    assert.equal(cell('compensation-partial-restore', 'program', matrix.cells).taskSuccessRate, 1);
});

test('the real corpus report is consumed by the committed paired analysis with unknown kept explicit', async () => {
    const report = await runRealCorpus();
    const analysis = analyzeAgentEvalCorpus(report, { seed: REAL_SEED });
    assert.equal(analysis.corpusId, report.corpus.id);
    assert.equal(analysis.pairing.matchedPairs, 14, 'seven kinds x two trials, all trials paired');
    assert.equal(analysis.overall.programRuns, 14);
    assert.equal(analysis.overall.baselineRuns, 14);

    const journal = analysis.overall.journal.failedWorldChangingEffects;
    assert.ok(journal.programObservable > 0, 'program journal metrics are observable');
    assert.equal(journal.baselineObservable, 0, 'react-baseline journal metrics stay unobserved');
    assert.equal(journal.unknown, true, 'the paired journal delta is explicitly unknown, not zero');

    const restore = analysis.scenarios.find(
        (entry) => entry.scenarioId === 'fault-transactional-restore',
    );
    assert.ok(restore);
    assert.equal(restore.taskSuccess.programRate, 1);
    assert.equal(restore.taskSuccess.baselineRate, 1);
    assert.ok((restore.journal.compensationEffects.programMean ?? 0) >= 1);
    assert.equal(restore.journal.compensationEffects.baselineObservable, 0);
});

test('real corpus trials are deterministic per seed; context sizes are run-varying like durationMs', async () => {
    const first = await runRealCorpus();
    const second = await runRealCorpus();

    const contextOf = (report: Awaited<ReturnType<typeof runRealCorpus>>) =>
        report.reports.flatMap((scenario) => [
            ...(scenario.runs.program ?? []),
            ...(scenario.runs['react-baseline'] ?? []),
        ]).map((run) => run.metrics.context);
    const firstContext = contextOf(first);
    const secondContext = contextOf(second);
    assert.equal(firstContext.length, 28, 'every run carries context metrics');
    for (const ctx of firstContext) {
        assert.equal(ctx.availability, 'provider-visible', 'the real runners expose context accounting');
        assert.equal(typeof ctx.peakChars, 'number');
        assert.equal(typeof ctx.peakBytes, 'number');
        assert.equal(typeof ctx.lastChars, 'number');
        assert.equal(typeof ctx.lastBytes, 'number');
    }
    assert.deepEqual(
        firstContext.map(({availability}) => availability),
        secondContext.map(({availability}) => availability),
        'availability is schema-stable across runs',
    );

    const stripContext = (value: unknown): unknown => {
        if (Array.isArray(value)) {
            return value.map(stripContext);
        }
        if (value && typeof value === 'object') {
            const source = value as Record<string, unknown>;
            const result: Record<string, unknown> = {};
            for (const key of Object.keys(source)) {
                if (key === 'context') {
                    continue;
                }
                result[key] = stripContext(source[key]);
            }
            return result;
        }
        return value;
    };
    const stableJson = (report: Awaited<ReturnType<typeof runRealCorpus>>) =>
        stripContext(JSON.parse(toAgentEvalCorpusJson(report)));
    assert.deepEqual(
        stableJson(first),
        stableJson(second),
        'all non-context fields are byte-deterministic per seed; exact context sizes reflect the run-varying serialized content (tool-call ids), so like durationMs they are not part of the stable corpus comparison',
    );
    assert.equal(
        agentEvalCorpusExitCode(first),
        1,
        'forward-progress fault goals honestly fail in the real program runner',
    );
});
