import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildControlSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    loadObservationFixtures,
    type ControlCapability,
    type ControlKind,
    type ControlSnapshot,
    type ObservationFixture,
} from '../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const fixtureDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const outputPath = path.join(repositoryDirectory, 'docs/Development/reports/SnapshotV2Stage2Baseline.json');
const iterations = parsePositiveInteger(process.env.SNAPSHOT_STAGE2_ITERATIONS, 50);
const fixtures = await loadObservationFixtures(fixtureDirectory);

const fixtureResults = fixtures.map((fixture) => measureFixture(fixture, iterations));
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusVersion: 'snapshot-v2-stage2-v1',
    iterations,
    fixtureCount: fixtureResults.length,
    inputNodeCount: fixtureResults.reduce((sum, fixture) => sum + fixture.inputNodeCount, 0),
    aggregate: aggregate(fixtureResults),
    fixtures: fixtureResults.map(({ timingSamples: _timingSamples, ...fixture }) => fixture),
};

const invariantFailures = fixtureResults.flatMap((fixture) =>
    fixture.validation.ok ? [] : [{ id: fixture.id, diagnostics: fixture.validation.diagnosticCodes }]);
const executableConflicts = fixtureResults.filter((fixture) => fixture.executableWithoutResolvedLocator > 0);
if (invariantFailures.length > 0 || executableConflicts.length > 0) {
    throw new Error(JSON.stringify({ invariantFailures, executableConflicts }, null, 2));
}

await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(outputPath);
console.log(JSON.stringify({
    corpusVersion: report.corpusVersion,
    fixtureCount: report.fixtureCount,
    inputNodeCount: report.inputNodeCount,
    controls: report.aggregate.controlCount,
    executableControls: report.aggregate.executableControlCount,
    locators: report.aggregate.locatorCount,
    unresolvedLocators: report.aggregate.locatorStatus.unresolved ?? 0,
    invariantFailures: report.aggregate.validationFailureCount,
    timing: report.aggregate.timing,
}, null, 2));

type MeasuredFixture = ReturnType<typeof measureFixture>;

function measureFixture(fixture: ObservationFixture, sampleCount: number) {
    const locatorSamples: number[] = [];
    const controlSamples: number[] = [];
    let finalSnapshot: ControlSnapshot | undefined;
    for (let iteration = 0; iteration < sampleCount; iteration += 1) {
        const observation = buildPageObservation(fixture.capture);
        const relations = buildRelationIndex(observation);
        const locatorStartedAt = performance.now();
        const locators = buildLocatorIndex(observation);
        locatorSamples.push(performance.now() - locatorStartedAt);
        const controlStartedAt = performance.now();
        finalSnapshot = buildControlSnapshot({ observation, relations, locators });
        controlSamples.push(performance.now() - controlStartedAt);
    }
    if (!finalSnapshot) {throw new Error(`fixture ${fixture.id} produced no samples`);}

    const controls = Object.values(finalSnapshot.controls.controls);
    const locators = Object.values(finalSnapshot.locators.locators);
    const executable = controls.filter((control) => control.capabilities.length > 0);
    const executableWithoutResolvedLocator = executable.filter((control) =>
        !control.locatorIds.some((locatorId) => finalSnapshot?.locators.locators[locatorId]?.status === 'resolved')).length;
    return {
        id: fixture.id,
        category: fixture.category,
        source: fixture.source,
        inputNodeCount: fixture.capture.nodes.length,
        controlCount: controls.length,
        controlKinds: countBy(controls.map((control) => control.kind)),
        controlStatus: countBy(controls.map((control) => control.status)),
        capabilities: countBy(controls.flatMap((control) => control.capabilities)),
        executableControlCount: executable.length,
        executableWithoutResolvedLocator,
        duplicateRefCount: Object.values(finalSnapshot.controls.byRef).filter((ids) => ids.length > 1).length,
        customSelect: {
            total: controls.filter((control) => control.kind === 'custom_select').length,
            complete: controls.filter((control) => control.kind === 'custom_select' && control.status === 'complete').length,
            partial: controls.filter((control) => control.kind === 'custom_select' && control.status === 'partial').length,
            ambiguous: controls.filter((control) => control.kind === 'custom_select' && control.status === 'ambiguous').length,
        },
        locatorCount: locators.length,
        locatorStatus: countBy(locators.map((locator) => locator.status)),
        locatorStrategy: countBy(locators.map((locator) => locator.strategy ?? 'none')),
        validation: {
            ok: finalSnapshot.controls.validation.ok,
            diagnosticCodes: countBy(finalSnapshot.controls.validation.diagnostics.map((diagnostic) => diagnostic.code)),
        },
        diagnosticCodes: countBy(finalSnapshot.controls.diagnostics.map((diagnostic) => diagnostic.code)),
        timing: {
            locator: distribution(locatorSamples),
            control: distribution(controlSamples),
        },
        timingSamples: { locator: locatorSamples, control: controlSamples },
    };
}

function aggregate(fixtures: MeasuredFixture[]) {
    const allLocatorSamples = fixtures.flatMap((fixture) => fixture.timingSamples.locator);
    const allControlSamples = fixtures.flatMap((fixture) => fixture.timingSamples.control);
    return {
        controlCount: fixtures.reduce((sum, fixture) => sum + fixture.controlCount, 0),
        executableControlCount: fixtures.reduce((sum, fixture) => sum + fixture.executableControlCount, 0),
        executableWithoutResolvedLocator: fixtures.reduce((sum, fixture) => sum + fixture.executableWithoutResolvedLocator, 0),
        duplicateRefCount: fixtures.reduce((sum, fixture) => sum + fixture.duplicateRefCount, 0),
        controlKinds: mergeCounts(fixtures.map((fixture) => fixture.controlKinds)),
        controlStatus: mergeCounts(fixtures.map((fixture) => fixture.controlStatus)),
        capabilities: mergeCounts(fixtures.map((fixture) => fixture.capabilities)),
        locatorCount: fixtures.reduce((sum, fixture) => sum + fixture.locatorCount, 0),
        locatorStatus: mergeCounts(fixtures.map((fixture) => fixture.locatorStatus)),
        locatorStrategy: mergeCounts(fixtures.map((fixture) => fixture.locatorStrategy)),
        validationFailureCount: fixtures.filter((fixture) => !fixture.validation.ok).length,
        validationDiagnosticCodes: mergeCounts(fixtures.map((fixture) => fixture.validation.diagnosticCodes)),
        timing: {
            locator: distribution(allLocatorSamples),
            control: distribution(allControlSamples),
        },
    };
}

function countBy(values: readonly (string | ControlKind | ControlCapability)[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) {counts[value] = (counts[value] ?? 0) + 1;}
    return counts;
}

function mergeCounts(records: readonly Record<string, number>[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) {counts[key] = (counts[key] ?? 0) + value;}
    }
    return counts;
}

function distribution(samples: readonly number[]) {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        samples: sorted.length,
        p50Ms: round(percentile(sorted, 0.50)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
    };
}

function percentile(sorted: readonly number[], ratio: number): number {
    if (sorted.length === 0) {return 0;}
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function round(value: number): number {return Number(value.toFixed(3));}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
