import { expect, test } from '@playwright/test';
import {
    runAgentEvalCorpus,
    toAgentEvalCorpusJson,
} from '../../../src/agent/execution/eval/corpus';
import { analyzeAgentEvalCorpus } from '../../../src/agent/execution/eval/analysis/analyze';
import type { AgentEvalRun } from '../../../src/agent/execution/eval/contracts';
import type { AgentFaultWorld } from '../../../src/agent/execution/eval/faults/contracts';
import type { AgentFaultKind } from '../../../src/agent/execution/eval/faults/contracts';
import { createPageFaultWorld } from '../../helpers/agent_fault_world';
import { createRealAgentFaultCorpus } from '../../helpers/agent_eval_real_corpus';
import { openLiveAgentEvalSession } from '../../live/agent/runner';

const REAL_E2E_SEED = 7788;

const holder: { current?: AgentFaultWorld } = {};

const runRealBrowserCorpus = async (kinds: readonly AgentFaultKind[], trials = 1) =>
    runAgentEvalCorpus(
        createRealAgentFaultCorpus({
            world: async () => {
                if (!holder.current) {
                    throw new Error('browser fault world is not loaded');
                }
                return holder.current;
            },
            kinds,
            trials,
            seed: REAL_E2E_SEED,
        }),
        { seed: REAL_E2E_SEED },
    );

const programRun = (
    report: Awaited<ReturnType<typeof runRealBrowserCorpus>>,
    kind: AgentFaultKind,
    mode: 'program' | 'react-baseline',
): AgentEvalRun => {
    const entry = report.reports.find((candidate) => candidate.scenario.id === `fault-${kind}`);
    const run = entry?.runs[mode]?.[0];
    if (!run) {
        throw new Error(`missing ${kind}/${mode} real browser run`);
    }
    return run;
};

const evidenceOf = (
    run: AgentEvalRun,
): { pageEpoch: number; values: Record<string, string>; events: { kind: string }[] } =>
    run.verification.evidence as {
        pageEpoch: number;
        values: Record<string, string>;
        events: { kind: string }[];
    };

test('real fault corpus drives the production runners against a real browser DOM', async () => {
    const session = await openLiveAgentEvalSession({ model: 'none' });
    try {
        holder.current = createPageFaultWorld(session.page);
        const report = await runRealBrowserCorpus([
            'transactional-restore',
            'mutation-report-error',
            'external-mutation-conflict',
            'epoch-navigation',
        ]);
        expect(report.corpus.id).toBe('agent-fault-real-execution-benchmark');
        expect(report.corpus.seed).toBe(REAL_E2E_SEED);

        // The external verifier inspects the real DOM at each scenario's verify.
        const restore = programRun(report, 'transactional-restore', 'program');
        expect(restore.success).toBe(true);
        expect(evidenceOf(restore).values.name).toBe('Before');
        const restoreJournal = restore.result.programs?.[0]?.effects;
        expect(
            restoreJournal?.map((effect) => [effect.stepName, effect.status, effect.compensates]),
        ).toEqual([
            ['browser.fill', 'failed', undefined],
            ['browser.fill', 'succeeded', 1],
        ]);

        const reportError = programRun(report, 'mutation-report-error', 'react-baseline');
        expect(reportError.success).toBe(true);
        expect(evidenceOf(reportError).values.name).toBe('Alice');
        expect(evidenceOf(reportError).values.result).toBe('submit');

        const conflict = programRun(report, 'external-mutation-conflict', 'program');
        expect(conflict.success).toBe(true);
        expect(evidenceOf(conflict).values.name).toBe('Alice');
        expect(evidenceOf(conflict).events.some((event) => event.kind === 'external-mutate')).toBe(
            true,
        );

        const nav = programRun(report, 'epoch-navigation', 'program');
        expect(evidenceOf(nav).pageEpoch).toBe(2);
        expect(evidenceOf(nav).events.some((event) => event.kind === 'navigation')).toBe(true);
        expect(evidenceOf(nav).values.name).toBe('Before');
        expect(programRun(report, 'epoch-navigation', 'react-baseline').success).toBe(true);

        // The final scenario leaves the live DOM at its last verified state.
        await expect(session.page.locator('#field-name')).toHaveValue('Alice');

        for (const run of [
            restore,
            programRun(report, 'transactional-restore', 'react-baseline'),
        ]) {
            if (run.mode === 'react-baseline') {
                expect(run.metrics.effects.availability).toBe('not-exposed');
                expect(run.metrics.recoverySuccess).toBeNull();
            }
        }
    } finally {
        await session.close();
    }
});

test('real browser fault reports are deterministic per seed and consumable by the paired analysis', async () => {
    const session = await openLiveAgentEvalSession({ model: 'none' });
    try {
        holder.current = createPageFaultWorld(session.page);
        const first = await runRealBrowserCorpus(['transactional-restore', 'ambiguous-timeout']);
        holder.current = createPageFaultWorld(session.page);
        const second = await runRealBrowserCorpus(['transactional-restore', 'ambiguous-timeout']);
        const a = toAgentEvalCorpusJson(first);
        const b = toAgentEvalCorpusJson(second);
        expect(a).toBe(b);
        expect(a.includes('"generatedAt"')).toBe(false);

        const analysis = analyzeAgentEvalCorpus(first, { seed: REAL_E2E_SEED });
        expect(analysis.scenarios.map((entry) => entry.scenarioId)).toEqual([
            'fault-transactional-restore',
            'fault-ambiguous-timeout',
        ]);
        expect(analysis.pairing.matchedPairs).toBe(2);
        expect(
            analysis.overall.journal.failedWorldChangingEffects.programObservable,
        ).toBeGreaterThan(0);
        expect(analysis.overall.journal.failedWorldChangingEffects.baselineObservable).toBe(0);
        expect(analysis.overall.journal.failedWorldChangingEffects.unknown).toBe(true);
    } finally {
        await session.close();
    }
});
