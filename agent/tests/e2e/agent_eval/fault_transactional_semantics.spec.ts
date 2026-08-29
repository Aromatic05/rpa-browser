import {expect, test} from '@playwright/test';
import {runAgentEvalCorpus, toAgentEvalCorpusJson, agentEvalCorpusExitCode} from '../../../src/agent/execution/eval/corpus';
import {AGENT_FAULT_SCENARIO_ID_PREFIX} from '../../../src/agent/execution/eval/faults/scenarios';
import type {AgentFaultKind} from '../../../src/agent/execution/eval/faults/contracts';
import {AGENT_FAULT_KINDS} from '../../../src/agent/execution/eval/faults/contracts';
import {buildAgentFaultMatrix} from '../../../src/agent/execution/eval/faults/matrix';
import {createAgentFaultCorpus} from '../../helpers/agent_fault_entries';
import {createPageFaultWorld} from '../../helpers/agent_fault_world';
import {openLiveAgentEvalSession} from '../../live/agent/runner';

const FAULT_E2E_SEED = 778;
const FAULT_E2E_TRIALS = 2;

const runBrowserFaultCorpus = async (
    session: Awaited<ReturnType<typeof openLiveAgentEvalSession>>,
    kinds: readonly AgentFaultKind[] = AGENT_FAULT_KINDS,
) => runAgentEvalCorpus(
    createAgentFaultCorpus({
        backend: 'browser',
        seed: FAULT_E2E_SEED,
        trials: FAULT_E2E_TRIALS,
        kinds,
        faultWorld: () => createPageFaultWorld(session.page),
    }),
    {seed: FAULT_E2E_SEED},
);

test('fault corpus runs all seven transactional fault kinds against a real browser page', async () => {
    const session = await openLiveAgentEvalSession({model: 'none'});
    try {
        const report = await runBrowserFaultCorpus(session);
        expect(report.corpus.id).toBe('agent-fault-transactional-benchmark');
        expect(report.corpus.scenarioIds).toEqual(
            AGENT_FAULT_KINDS.map((kind) => `${AGENT_FAULT_SCENARIO_ID_PREFIX}${kind}`),
        );
        expect(agentEvalCorpusExitCode(report)).toBe(0);
        expect(report.aggregates.program?.taskSuccess.rate).toBe(1);
        expect(report.aggregates['react-baseline']?.taskSuccess.rate).toBe(1);

        const matrix = buildAgentFaultMatrix(report.reports);
        const cellFor = (kind: AgentFaultKind, mode: 'program' | 'react-baseline') => {
            const found = matrix.cells.find((entry) => entry.faultKind === kind && entry.mode === mode);
            expect(found).toBeDefined();
            return found!;
        };

        for (const kind of AGENT_FAULT_KINDS) {
            expect(cellFor(kind, 'program').postRewindReplayEffects).toBe(0);
            expect(cellFor(kind, 'program').redundantAppliedEffects).toBe(0);
            expect(cellFor(kind, 'program').faultRecoveryRate).toBe(1);
            expect(cellFor(kind, 'react-baseline').journalRecovery).toBe('unknown');
        }

        const restore = cellFor('transactional-restore', 'program');
        expect(restore.transactionalCompensations).toBe(2);
        expect(restore.adHocRestores).toBe(0);
        expect(cellFor('transactional-restore', 'react-baseline').adHocRestores).toBe(2);
        expect(cellFor('compensation-partial-restore', 'program').transactionalCompensations).toBe(4);
        expect(cellFor('mutation-report-error', 'react-baseline').redundantAppliedEffects).toBe(2);
        expect(cellFor('external-mutation-conflict', 'program').conflictsDetected).toBe(2);
        expect(cellFor('external-mutation-conflict', 'react-baseline').conflictsDetected).toBe(0);

        for (const entry of report.reports) {
            for (const run of entry.runs['react-baseline'] ?? []) {
                expect(run.metrics.effects.availability).toBe('not-exposed');
                expect(run.metrics.recoverySuccess).toBeNull();
            }
        }
    } finally {
        await session.close();
    }
});

test('transactional restore leaves the real DOM at the pre-effect value and navigation reloads the real document', async () => {
    const session = await openLiveAgentEvalSession({model: 'none'});
    try {
        const restoreReport = await runBrowserFaultCorpus(session, ['transactional-restore']);
        const restoreProgram = restoreReport.reports[0]?.runs.program?.[0];
        expect(restoreProgram?.success).toBe(true);
        await expect(session.page.locator('#field-name')).toHaveValue('Before');
        const restoreEvidence = restoreProgram?.verification.evidence as {
            events: {kind: string; value?: string}[];
        };
        const stray = restoreEvidence.events.filter((event) => event.value === 'Alice~partial');
        expect(stray.length).toBeGreaterThan(0);

        const navReport = await runBrowserFaultCorpus(session, ['epoch-navigation']);
        const navEvidence = (navReport.reports[0]?.runs.program?.[0]?.verification.evidence) as {
            pageEpoch: number;
            events: {kind: string; key: string; value?: string; sequence: number}[];
        };
        expect(navEvidence.pageEpoch).toBe(2);
        const navigation = navEvidence.events.find((event) => event.kind === 'navigation');
        expect(navigation).toBeDefined();
        const postReloadRead = navEvidence.events.find((event) => event.kind === 'read'
            && event.value === 'Before'
            && event.sequence > (navigation?.sequence ?? 0));
        expect(postReloadRead).toBeDefined();
        await expect(session.page.locator('#field-name')).toHaveValue('Alice');
    } finally {
        await session.close();
    }
});

test('browser fault reports are deterministic per seed', async () => {
    const session = await openLiveAgentEvalSession({model: 'none'});
    try {
        const first = toAgentEvalCorpusJson(await runBrowserFaultCorpus(session, ['revision-drift', 'ambiguous-timeout']));
        const second = toAgentEvalCorpusJson(await runBrowserFaultCorpus(session, ['revision-drift', 'ambiguous-timeout']));
        expect(first).toBe(second);
        expect(first.includes('"generatedAt"')).toBe(false);
    } finally {
        await session.close();
    }
});
