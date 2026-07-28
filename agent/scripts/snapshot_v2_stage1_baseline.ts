import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
    buildPageObservation,
    captureRawPage,
    loadObservationFixtures,
    runObservationLaboratory,
} from '../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const fixtureDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const defaultOutputPath = path.join(
    repositoryDirectory,
    'docs/Development/reports/SnapshotV2Stage1Baseline.json',
);
const outputPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : defaultOutputPath;
const iterations = parsePositiveInteger(process.env.SNAPSHOT_V2_BASELINE_ITERATIONS, 50);

const fixtures = await loadObservationFixtures(fixtureDirectory);
const laboratory = runObservationLaboratory(fixtures, {
    iterations,
    corpusVersion: 'snapshot-v2-stage1-v2',
});
const liveCapture = await measureLiveCapture(Math.max(10, Math.min(iterations, 30)));
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusVersion: laboratory.corpusVersion,
    fixedCorpus: laboratory,
    liveCapture,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(outputPath);

async function measureLiveCapture(sampleCount: number) {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
        await page.setContent(`
            <!doctype html>
            <html>
              <body>
                <form aria-label="Profile">
                  <label for="name">Name</label>
                  <input id="name" value="Alice" />
                  <button type="submit">Save</button>
                </form>
                <div class="el-table">
                  <table><tbody><tr><td>Alice</td></tr></tbody></table>
                </div>
                <div class="ant-form">
                  <button aria-controls="city-popup" aria-expanded="false">City</button>
                </div>
                <div id="city-popup" role="listbox"><div role="option">Tokyo</div></div>
              </body>
            </html>
        `, { waitUntil: 'domcontentloaded' });

        const captureSamples: number[] = [];
        const observationSamples: number[] = [];
        let maximumNodeCount = 0;
        let maximumScopeCount = 0;
        for (let index = 0; index < sampleCount; index += 1) {
            const captureStartedAt = performance.now();
            const raw = await captureRawPage(page, { captureRuntimeState: true });
            captureSamples.push(performance.now() - captureStartedAt);
            try {
                const observationStartedAt = performance.now();
                const observation = buildPageObservation(raw.capture);
                observationSamples.push(performance.now() - observationStartedAt);
                maximumNodeCount = Math.max(maximumNodeCount, Object.keys(observation.nodes).length);
                maximumScopeCount = Math.max(
                    maximumScopeCount,
                    Object.keys(observation.scopes.scopes).length,
                );
            } finally {
                await raw.cleanup();
            }
        }
        return {
            source: 'browser-live',
            sampleCount,
            maximumNodeCount,
            maximumScopeCount,
            capture: distribution(captureSamples),
            observation: distribution(observationSamples),
        };
    } finally {
        await browser.close();
    }
}

function distribution(samples: readonly number[]) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        samples: sorted.length,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
    };
}

function percentile(sorted: readonly number[], ratio: number): number {
    if (sorted.length === 0) {return 0;}
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
    return sorted[index] ?? 0;
}

function round(value: number): number {
    return Math.round(value * 1000) / 1000;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
