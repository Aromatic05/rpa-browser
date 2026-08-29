import test from 'node:test';
import assert from 'node:assert/strict';
import {runAgentEvalCorpus} from '../../../../../../src/agent/execution/eval/corpus';
import {
    buildAgentFaultMatrix,
    faultMatrixToJson,
    faultMatrixToMarkdown,
} from '../../../../../../src/agent/execution/eval/faults/matrix';
import {createAgentFaultCorpus} from '../../../../../helpers/agent_fault_entries';

const MATRIX_SEED = 555;

const runMatrixCorpus = async () => runAgentEvalCorpus(
    createAgentFaultCorpus({
        backend: 'fixture',
        seed: MATRIX_SEED,
        kinds: ['transactional-restore', 'external-mutation-conflict'],
        trials: 1,
    }),
    {seed: MATRIX_SEED},
);

test('matrix orders cells by fault kind with program first and keeps baseline journal metrics unknown', async () => {
    const report = await runMatrixCorpus();
    const matrix = buildAgentFaultMatrix(report.reports);
    assert.deepEqual(matrix.cells.map((entry) => `${entry.faultKind}/${entry.mode}`), [
        'transactional-restore/program',
        'transactional-restore/react-baseline',
        'external-mutation-conflict/program',
        'external-mutation-conflict/react-baseline',
    ]);
    const baseline = matrix.cells.find((entry) => entry.mode === 'react-baseline'
        && entry.faultKind === 'transactional-restore');
    assert.ok(baseline);
    assert.equal(baseline.failedWorldChangingEffects, 'unknown');
    assert.equal(baseline.transactionalCompensations, 'unknown');
    assert.equal(baseline.journalRecovery, 'unknown');
    assert.equal(baseline.journalAvailability, 'not-exposed');
    assert.equal(baseline.unknownMetricCount, 4, 'four journal-derived metrics unknown per baseline trial');
    const program = matrix.cells.find((entry) => entry.mode === 'program'
        && entry.faultKind === 'transactional-restore');
    assert.ok(program);
    assert.equal(program.unknownMetricCount, 0);
    assert.deepEqual(program.journalRecovery, {passed: 1, count: 1});
    assert.equal(program.transactionalCompensations, 1);
});

test('matrix serialization is deterministic and markdown renders unknown cells', async () => {
    const first = faultMatrixToJson(buildAgentFaultMatrix((await runMatrixCorpus()).reports));
    const second = faultMatrixToJson(buildAgentFaultMatrix((await runMatrixCorpus()).reports));
    assert.equal(first, second);
    assert.equal(first.includes('durationMs'), false);
    assert.equal(first.includes('generatedAt'), false);
    const parsed = JSON.parse(first) as {version: number; cells: unknown[]};
    assert.equal(parsed.version, 1);
    assert.equal(parsed.cells.length, 4);

    const markdown = faultMatrixToMarkdown(buildAgentFaultMatrix((await runMatrixCorpus()).reports));
    assert.ok(markdown.startsWith('# agent fault matrix'));
    assert.ok(markdown.includes('transactional-restore | react-baseline'));
    assert.equal(markdown.match(/unknown/g)?.length, 4,
        'each baseline row exposes exactly failedWorld and compensations as unknown');
});

test('matrix ignores non-fault scenario reports', async () => {
    const report = await runMatrixCorpus();
    const foreign = structuredClone(report.reports[0]);
    const mixed = buildAgentFaultMatrix([
        {...foreign, scenario: {...foreign.scenario, id: 'form-fill-submit'}},
        ...report.reports,
    ]);
    assert.equal(mixed.cells.length, 4);
});
