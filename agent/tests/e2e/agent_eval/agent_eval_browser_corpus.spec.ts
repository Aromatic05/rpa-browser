import {expect, test} from '@playwright/test';
import {readFile, writeFile} from 'node:fs/promises';
import {runAgentEvalCorpus, agentEvalCorpusExitCode, toAgentEvalCorpusJson} from '../../../src/agent/execution/eval/corpus';
import {createAgentEvalBenchmarkCorpus} from '../../helpers/agent_eval_entries';
import {openLiveAgentEvalSession} from '../../live/agent/runner';

const SEED = 777;
const TRIALS = 2;

const SCENARIO_IDS = [
    'form-fill-submit',
    'failed-mutation-recovery',
    'side-effect-compensation',
    'drift-stale-target',
    'multi-step-order',
];

const runBrowserCorpus = async (sessionWorld: Awaited<ReturnType<typeof openLiveAgentEvalSession>>) => {
    const corpus = createAgentEvalBenchmarkCorpus({
        backend: 'browser',
        seed: SEED,
        trials: TRIALS,
        pageWorld: () => sessionWorld.world,
    });
    return runAgentEvalCorpus(corpus, {seed: SEED});
};

test('agent_eval fixture corpus completes all five categories against a real browser page', async () => {
    const session = await openLiveAgentEvalSession({model: 'none'});
    try {
        const report = await runBrowserCorpus(session);
        expect(report.corpus.scenarioIds).toEqual(SCENARIO_IDS);
        expect(agentEvalCorpusExitCode(report)).toBe(0);
        expect(report.aggregates.program?.taskSuccess.rate).toBe(1);
        expect(report.aggregates['react-baseline']?.taskSuccess.rate).toBe(1);

        const sideEffect = report.reports.find((entry) => entry.scenario.id === 'side-effect-compensation');
        const sideEffectProgram = sideEffect?.runs.program?.[0];
        expect(sideEffectProgram?.metrics.effects.failedWorldChangingEffects).toBe(1);
        expect(sideEffectProgram?.metrics.effects.compensationEffects).toBe(1);
        expect(sideEffectProgram?.metrics.recoverySuccess).toBe(true);

        const staleProgram = report.reports
            .find((entry) => entry.scenario.id === 'drift-stale-target')
            ?.runs.program?.[0];
        expect(staleProgram?.metrics.repair.refreshCalls).toBe(1);

        for (const entry of report.reports) {
            for (const run of entry.runs['react-baseline'] ?? []) {
                expect(run.metrics.effects.availability).toBe('not-exposed');
                expect(run.metrics.effects.worldEffectCalls).toBeNull();
                expect(run.metrics.effects.failedWorldChangingEffects).toBeNull();
                expect(run.metrics.recoverySuccess).toBeNull();
            }
        }

        const multiStep = report.reports.find((entry) => entry.scenario.id === 'multi-step-order');
        expect(multiStep?.runs.program?.length).toBe(TRIALS);
        expect(multiStep?.aggregates.program?.effectCalls.mean).toBe(0);
        const programWorldEffects = multiStep?.aggregates.program?.worldEffectCalls;
        expect(programWorldEffects && 'mean' in programWorldEffects ? programWorldEffects.mean : null).toBe(3);

        // Independent external observation: read the live DOM directly, bypassing the world port.
        await expect(session.page.locator('#field-name')).toHaveValue('Alice');
        await expect(session.page.locator('#field-country')).toHaveValue('NL');
        await expect(session.page.locator('#field-result')).toHaveValue('submit');
    } finally {
        await session.close();
    }
});

test('agent_eval browser reports serialize deterministically per seed and persist to file', async ({}, testInfo) => {
    const session = await openLiveAgentEvalSession({model: 'none'});
    try {
        const first = toAgentEvalCorpusJson(await runBrowserCorpus(session));
        const second = toAgentEvalCorpusJson(await runBrowserCorpus(session));
        expect(first).toBe(second);
        expect(first.includes('"generatedAt"')).toBe(false);
        expect(first.includes('durationMs')).toBe(false);
        expect(first.toLowerCase().includes('apikey')).toBe(false);

        const outputPath = testInfo.outputPath('agent_eval_browser_report.json');
        await writeFile(outputPath, first, 'utf8');
        const parsed = JSON.parse(await readFile(outputPath, 'utf8'));
        expect(parsed.corpus.seed).toBe(SEED);
        expect(parsed.corpus.id).toBe('agent-eval-browser-benchmark');
        expect(parsed.trialSeeds['form-fill-submit']).toEqual([
            parsed.trialSeeds['form-fill-submit'][0],
            parsed.trialSeeds['form-fill-submit'][1],
        ]);
        expect(parsed.trialSeeds['form-fill-submit'].length).toBe(TRIALS);
        const programRows = parsed.reports[0].runs.program;
        expect(programRows.map((row: {trialIndex: number}) => row.trialIndex)).toEqual([0, 1]);
        expect(programRows[0].metrics.taskSuccess).toBe(true);
    } finally {
        await session.close();
    }
});
