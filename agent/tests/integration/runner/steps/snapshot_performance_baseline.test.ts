import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    loadObservationFixtures,
    runObservationReplayBenchmark,
    type ObservationReplayBenchmarkReport,
} from '../../../../src/snapshot';

const enabled = process.env.SNAPSHOT_V2_PERF_BASELINE === '1';
const iterations = positiveInteger(process.env.SNAPSHOT_V2_PERF_ITERATIONS, 20);
const timingRatio = positiveNumber(process.env.SNAPSHOT_V2_PERF_MAX_TIMING_RATIO, 8);
const timingFloorMs = positiveNumber(process.env.SNAPSHOT_V2_PERF_TIMING_FLOOR_MS, 2);
const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const fixtureDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const baselinePath = path.join(
    repositoryDirectory,
    'docs/Development/reports/SnapshotV2Stage1Baseline.json',
);

test('Snapshot V2 frozen corpus preserves work-set and p50/p95 performance bounds', {skip: !enabled}, async () => {
    const fixtures = await loadObservationFixtures(fixtureDirectory);
    const report = runObservationReplayBenchmark(fixtures, {
        iterations,
        corpusVersion: 'snapshot-v2-stage1-v2',
    });
    const baseline = await readBaseline();

    assert.equal(report.corpusVersion, baseline.corpusVersion);
    assert.equal(report.fixtureCount, baseline.fixtureCount);
    assert.ok(report.fixtureCount > 0);
    assert.equal(report.fixtures.every((fixture) => fixture.decision.invariantOk), true);
    assert.deepEqual(report.fixtures.flatMap((fixture) => fixture.truthErrors), []);

    assert.deepEqual(report.aggregate.candidateCounts, baseline.aggregate.candidateCounts);
    assert.deepEqual(report.aggregate.workSet, baseline.aggregate.workSet);
    assert.equal(report.aggregate.workSet.orphanCount, 0);
    assert.ok(report.aggregate.workSet.maximumUnionRatio <= 1);

    for (const fixture of report.fixtures) {
        assert.ok(fixture.workSet.maxSize <= fixture.input.nodeCount);
        assert.ok(fixture.workSet.p50Size <= fixture.workSet.p95Size);
        assert.ok(fixture.workSet.p95Size <= fixture.workSet.maxSize);
        assert.ok(fixture.workSet.unionRatio <= 1);
        assert.ok(
            fixture.workSet.peakRetainedIndexEntries <= fixture.input.nodeCount * 20,
            `${fixture.id} retained too many index entries`,
        );
    }

    for (const [passName, timing] of Object.entries(report.aggregate.timing)) {
        const expected = baseline.aggregate.timing[passName];
        assert.ok(expected, `baseline timing missing pass: ${passName}`);
        assertTimingBound(passName, 'p50Ms', timing.p50Ms, expected.p50Ms);
        assertTimingBound(passName, 'p95Ms', timing.p95Ms, expected.p95Ms);
    }

    console.info('[snapshot-v2-perf]', JSON.stringify({
        iterations,
        fixtureCount: report.fixtureCount,
        inputNodeCount: report.aggregate.inputNodeCount,
        workSet: report.aggregate.workSet,
        timing: report.aggregate.timing,
        timingRatio,
        timingFloorMs,
    }));
});

const readBaseline = async (): Promise<ObservationReplayBenchmarkReport> => {
    const content = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as {
        fixedCorpus?: ObservationReplayBenchmarkReport;
    };
    assert.ok(content.fixedCorpus, 'Stage 1 fixed corpus baseline is missing');
    return content.fixedCorpus;
};

const assertTimingBound = (
    passName: string,
    metric: 'p50Ms' | 'p95Ms',
    actual: number,
    expected: number,
): void => {
    const maximum = Math.max(timingFloorMs, expected * timingRatio);
    assert.ok(
        actual <= maximum,
        `${passName}.${metric} regression: ${actual.toFixed(3)}ms > ${maximum.toFixed(3)}ms `
            + `(baseline=${expected.toFixed(3)}ms ratio=${timingRatio})`,
    );
};

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function positiveNumber(value: string | undefined, fallback: number): number {
    const parsed = Number.parseFloat(value ?? '');
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
