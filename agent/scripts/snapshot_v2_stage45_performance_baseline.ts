import {promises as fs} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
    loadObservationFixtures,
    runSnapshotFullPipelineBenchmark,
} from '../src/snapshot';
import {createV2BusinessPage} from '../tests/helpers/v2_business_page';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const iterations = positiveInteger(process.env.SNAPSHOT_V2_FULL_PERF_ITERATIONS, 40);
const fixtures = await loadObservationFixtures(path.join(agentDirectory, 'tests/fixtures/observation-v2'));
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
const outputPath = path.join(
    repositoryDirectory,
    'docs/Development/reports/SnapshotV2Stage45PerformanceBaseline.json',
);
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.info(JSON.stringify({outputPath, iterations, structure: report.structure, timing: report.timing}, null, 2));

function positiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
