import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    loadFormFixtures,
    type ObservationFixture,
    type FormFixture,
    type FormSnapshot,
} from '../src/snapshot';

const agentDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryDirectory = path.resolve(agentDirectory, '..');
const fixtureDirectory = path.join(agentDirectory, 'tests/fixtures/form-v2');
const outputPath = path.join(repositoryDirectory, 'docs/Development/reports/SnapshotV2Stage3Baseline.json');
const iterations = parsePositiveInteger(process.env.SNAPSHOT_STAGE3_ITERATIONS, 50);
const fixtures = await loadFormFixtures(fixtureDirectory);
const observationFixtureDirectory = path.join(agentDirectory, 'tests/fixtures/observation-v2');
const listFixtures = await loadListFormFixtures(observationFixtureDirectory);
const measured = [...fixtures, ...listFixtures].map((fixture) => measureFixture(fixture, iterations));
const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusVersion: 'snapshot-v2-stage3-v1',
    iterations,
    fixtureCount: measured.length,
    inputNodeCount: measured.reduce((sum, item) => sum + item.inputNodeCount, 0),
    aggregate: aggregate(measured),
    fixtures: measured.map(({ samples: _samples, ...item }) => item),
};
const failures = measured.filter((item) => !item.validation.ok || item.truthErrors.length > 0);
if (failures.length > 0) {
    throw new Error(JSON.stringify(failures.map((item) => ({
        id: item.id,
        validation: item.validation,
        truthErrors: item.truthErrors,
    })), null, 2));
}
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await fs.writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(outputPath);
console.log(JSON.stringify({
    corpusVersion: report.corpusVersion,
    fixtureCount: report.fixtureCount,
    inputNodeCount: report.inputNodeCount,
    forms: report.aggregate.formCount,
    fields: report.aggregate.fieldCount,
    compositeFields: report.aggregate.compositeFieldCount,
    residualFields: report.aggregate.residualFieldCount,
    ownedActions: report.aggregate.ownedActionCount,
    residualActions: report.aggregate.residualActionCount,
    ownershipEdges: report.aggregate.ownershipEdgeCount,
    invariantFailures: report.aggregate.validationFailureCount,
    timing: report.aggregate.timing,
}, null, 2));


async function loadListFormFixtures(directory: string): Promise<FormFixture[]> {
    const definitions = [
        {
            file: '09-element-plus-browser.v1.json',
            truth: { minimumFormCount: 1, minimumFieldCount: 1, expectedBoundaryKinds: ['explicit-form'] as const },
        },
        {
            file: '10-ant-design-browser.v1.json',
            truth: { minimumFormCount: 1, minimumFieldCount: 1, minimumResidualFieldCount: 1, expectedBoundaryKinds: ['explicit-form'] as const },
        },
    ];
    const output: FormFixture[] = [];
    for (const definition of definitions) {
        const source = JSON.parse(await fs.readFile(path.join(directory, definition.file), 'utf8')) as ObservationFixture;
        output.push({
            fixtureVersion: 1,
            id: `${source.id}-form-stage3`,
            category: `${source.category}-form-stage3`,
            source: {
                kind: 'browser-capture',
                framework: source.source.framework === 'platform' ? 'native' : source.source.framework,
                frameworkVersion: source.source.frameworkVersion,
                capturedAt: source.source.capturedAt,
                origin: source.source.origin,
            },
            truth: {
                minimumFormCount: definition.truth.minimumFormCount,
                minimumFieldCount: definition.truth.minimumFieldCount,
                minimumResidualFieldCount: 'minimumResidualFieldCount' in definition.truth
                    ? definition.truth.minimumResidualFieldCount
                    : undefined,
                expectedBoundaryKinds: [...definition.truth.expectedBoundaryKinds],
            },
            capture: source.capture,
        });
    }
    return output;
}

type Measured = ReturnType<typeof measureFixture>;

function measureFixture(fixture: FormFixture, sampleCount: number) {
    const samples: number[] = [];
    let finalSnapshot: FormSnapshot | undefined;
    for (let iteration = 0; iteration < sampleCount; iteration += 1) {
        const observation = buildPageObservation(fixture.capture);
        const relations = buildRelationIndex(observation);
        const locators = buildLocatorIndex(observation);
        const controls = buildControlSnapshot({ observation, relations, locators }).controls;
        const startedAt = performance.now();
        finalSnapshot = buildFormSnapshot({ observation, relations, locators, controls });
        samples.push(performance.now() - startedAt);
    }
    if (!finalSnapshot) throw new Error(`form fixture produced no samples: ${fixture.id}`);
    const forms = Object.values(finalSnapshot.forms.forms);
    const fields = Object.values(finalSnapshot.forms.fields);
    const truthErrors = validateTruth(fixture, finalSnapshot);
    return {
        id: fixture.id,
        category: fixture.category,
        source: fixture.source,
        inputNodeCount: fixture.capture.nodes.length,
        formCount: forms.length,
        fieldCount: fields.length,
        compositeFieldCount: fields.filter((field) => field.controlIds.length > 1).length,
        actionCount: Object.keys(finalSnapshot.forms.actions).length,
        ownedActionCount: forms.reduce((sum, form) => sum + form.actions.length, 0),
        residualActionCount: finalSnapshot.forms.residualActionIds.length,
        groupCount: Object.keys(finalSnapshot.forms.groups).length,
        residualFieldCount: finalSnapshot.forms.residualFieldIds.length,
        reductionOutcomes: countBy(finalSnapshot.forms.reductionTrace.map((item) => item.outcome)),
        reductionReasons: countBy(finalSnapshot.forms.reductionTrace.map((item) => item.reason)),
        componentSuggestions: countBy(forms.flatMap((form) => form.suggestions.map((item) => item.value))),
        actionSuggestions: countBy(Object.values(finalSnapshot.forms.actions).flatMap((action) => action.suggestions.map((item) => item.value))),
        boundaryKinds: countBy(forms.map((form) => form.boundaryKind)),
        formStatus: countBy(forms.map((form) => form.status)),
        ownershipEdgeCount: finalSnapshot.forms.ownership.edges.length,
        validation: {
            ok: finalSnapshot.forms.validation.ok,
            diagnosticCodes: countBy(finalSnapshot.forms.validation.diagnostics.map((item) => item.code)),
        },
        diagnosticCodes: countBy(finalSnapshot.forms.diagnostics.map((item) => item.code)),
        truthErrors,
        timing: distribution(samples),
        samples,
    };
}

function validateTruth(fixture: FormFixture, snapshot: FormSnapshot): string[] {
    const errors: string[] = [];
    const forms = Object.values(snapshot.forms.forms);
    const fields = Object.values(snapshot.forms.fields);
    if (forms.length < fixture.truth.minimumFormCount) errors.push(`formCount:${forms.length}`);
    if (fields.length < fixture.truth.minimumFieldCount) errors.push(`fieldCount:${fields.length}`);
    const composite = fields.filter((field) => field.controlIds.length > 1).length;
    if (composite < (fixture.truth.minimumCompositeFieldCount ?? 0)) errors.push(`compositeFieldCount:${composite}`);
    if (snapshot.forms.residualFieldIds.length < (fixture.truth.minimumResidualFieldCount ?? 0)) {
        errors.push(`residualFieldCount:${snapshot.forms.residualFieldIds.length}`);
    }
    for (const kind of fixture.truth.expectedBoundaryKinds ?? []) {
        if (!forms.some((form) => form.boundaryKind === kind)) errors.push(`boundaryKind:${kind}`);
    }
    if (fixture.truth.requireDialogHost && !forms.some((form) => Boolean(form.location.hostNodeId))) {
        errors.push('dialogHost:missing');
    }
    return errors;
}

function aggregate(fixtures: Measured[]) {
    const samples = fixtures.flatMap((fixture) => fixture.samples);
    return {
        formCount: sum(fixtures, (item) => item.formCount),
        fieldCount: sum(fixtures, (item) => item.fieldCount),
        compositeFieldCount: sum(fixtures, (item) => item.compositeFieldCount),
        actionCount: sum(fixtures, (item) => item.actionCount),
        ownedActionCount: sum(fixtures, (item) => item.ownedActionCount),
        residualActionCount: sum(fixtures, (item) => item.residualActionCount),
        groupCount: sum(fixtures, (item) => item.groupCount),
        residualFieldCount: sum(fixtures, (item) => item.residualFieldCount),
        ownershipEdgeCount: sum(fixtures, (item) => item.ownershipEdgeCount),
        reductionOutcomes: mergeCounts(fixtures.map((item) => item.reductionOutcomes)),
        reductionReasons: mergeCounts(fixtures.map((item) => item.reductionReasons)),
        componentSuggestions: mergeCounts(fixtures.map((item) => item.componentSuggestions)),
        actionSuggestions: mergeCounts(fixtures.map((item) => item.actionSuggestions)),
        boundaryKinds: mergeCounts(fixtures.map((item) => item.boundaryKinds)),
        formStatus: mergeCounts(fixtures.map((item) => item.formStatus)),
        validationFailureCount: fixtures.filter((item) => !item.validation.ok).length,
        validationDiagnosticCodes: mergeCounts(fixtures.map((item) => item.validation.diagnosticCodes)),
        truthErrorCount: fixtures.reduce((total, item) => total + item.truthErrors.length, 0),
        timing: distribution(samples),
    };
}

function sum<T>(items: T[], read: (item: T) => number): number {
    return items.reduce((total, item) => total + read(item), 0);
}

function countBy(values: readonly string[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
    return counts;
}

function mergeCounts(records: readonly Record<string, number>[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const record of records) {
        for (const [key, value] of Object.entries(record)) counts[key] = (counts[key] ?? 0) + value;
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
    if (sorted.length === 0) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? 0;
}

function round(value: number): number {return Number(value.toFixed(3));}
function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
