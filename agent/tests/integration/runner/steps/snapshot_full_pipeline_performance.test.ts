import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    loadObservationFixtures,
    runSnapshotFullPipelineBenchmark,
    type SnapshotFullPipelineBenchmarkReport,
} from '../../../../src/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const enabled = process.env.SNAPSHOT_V2_FULL_PERF_BASELINE === '1';
const iterations = positiveInteger(process.env.SNAPSHOT_V2_FULL_PERF_ITERATIONS, 20);
const timingRatio = positiveNumber(process.env.SNAPSHOT_V2_FULL_PERF_MAX_TIMING_RATIO, 1.2);
const timingNoiseFloorMs = positiveNumber(process.env.SNAPSHOT_V2_FULL_PERF_NOISE_FLOOR_MS, 0.5);
const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const fixtureDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const baselinePath = path.join(
    repositoryDirectory,
    'docs/Development/reports/SnapshotV2Stage45PerformanceBaseline.json',
);

const requiredPasses = [
    'observation',
    'relation',
    'locator',
    'control',
    'form',
    'table',
    'query-plan-compile',
    'query-plan-execute',
    'semantic-bindings',
    'page-session-compose',
    'projection-full',
    'projection-overview',
    'semantic-diff',
    'annotator-projection',
] as const;

test('Snapshot V2 full pipeline preserves Stage 4/5 structure and performance bounds', {skip: !enabled}, async () => {
    const fixtures = await loadObservationFixtures(fixtureDirectory);
    const businessCases = [1, 25, 100].map((rowCount) => ({
        id: `business-rows-${rowCount}`,
        capture: createV2BusinessPage({rowCount, withGeometry: true}).capture,
    }));
    const report = await runSnapshotFullPipelineBenchmark({
        observationFixtures: fixtures,
        businessCases,
        iterations,
        corpusVersion: 'snapshot-v2-stage45-v1',
    });
    const baseline = JSON.parse(await fs.readFile(baselinePath, 'utf8')) as SnapshotFullPipelineBenchmarkReport;

    assert.equal(report.corpusVersion, baseline.corpusVersion);
    assert.deepEqual(report.structure, baseline.structure);
    assert.deepEqual(Object.keys(report.timing).sort(), [...requiredPasses].sort());
    assert.deepEqual(Object.keys(baseline.timing).sort(), [...requiredPasses].sort());

    for (const passName of requiredPasses) {
        const actual = report.timing[passName];
        const expected = baseline.timing[passName];
        assert.ok(actual.samples > 0, `${passName} has no samples`);
        assertTimingBound(passName, 'p50Ms', actual.p50Ms, expected.p50Ms);
        assertTimingBound(passName, 'p95Ms', actual.p95Ms, expected.p95Ms);
    }

    console.info('[snapshot-v2-full-perf]', JSON.stringify({
        iterations,
        structure: report.structure,
        timing: report.timing,
        timingRatio,
        timingNoiseFloorMs,
    }));
});

const assertTimingBound = (
    passName: string,
    metric: 'p50Ms' | 'p95Ms',
    actual: number,
    expected: number,
): void => {
    const maximum = Math.max(expected * timingRatio, expected + timingNoiseFloorMs);
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
