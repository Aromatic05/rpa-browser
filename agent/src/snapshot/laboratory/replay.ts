import { performance } from 'node:perf_hooks';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { analyzePageObservation } from '../analysis/analyze';
import { buildPageObservation } from '../observation/build';
import type {
    CandidateClassification,
    PageObservation,
    PageObservationAnalysis,
} from '../observation/contracts';
import type {
    ObservationFixture,
    ObservationFixtureLaboratoryResult,
    ObservationLaboratoryReport,
    TimingDistribution,
} from './contracts';

type MeasuredFixtureResult = {
    result: ObservationFixtureLaboratoryResult;
    timingSamples: ReadonlyMap<string, readonly number[]>;
    quotientSizes: readonly number[];
};

export const loadObservationFixtures = async (
    fixtureDirectory: string,
): Promise<ObservationFixture[]> => {
    const entries = await fs.readdir(fixtureDirectory, { withFileTypes: true });
    const fixturePaths = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(fixtureDirectory, entry.name))
        .sort();
    const fixtures: ObservationFixture[] = [];
    for (const fixturePath of fixturePaths) {
        const parsed = JSON.parse(await fs.readFile(fixturePath, 'utf8')) as ObservationFixture;
        validateFixtureMetadata(parsed, fixturePath);
        fixtures.push(parsed);
    }
    return fixtures;
};

export const replayObservationFixture = (
    fixture: ObservationFixture,
): PageObservationAnalysis => analyzePageObservation(buildPageObservation(fixture.capture));

export const runObservationLaboratory = (
    fixtures: readonly ObservationFixture[],
    options: {
        iterations?: number;
        corpusVersion?: string;
        generatedAt?: string;
    } = {},
): ObservationLaboratoryReport => {
    const iterations = Math.max(1, Math.floor(options.iterations ?? 25));
    const measuredFixtures = fixtures.map((fixture) => runFixture(fixture, iterations));
    const fixtureResults = measuredFixtures.map((fixture) => fixture.result);
    return {
        schemaVersion: 1,
        generatedAt: options.generatedAt ?? new Date().toISOString(),
        corpusVersion: options.corpusVersion ?? 'snapshot-v2-stage1-v2',
        iterations,
        fixtureCount: fixtureResults.length,
        fixtures: fixtureResults,
        aggregate: buildAggregate(measuredFixtures),
    };
};

const runFixture = (
    fixture: ObservationFixture,
    iterations: number,
): MeasuredFixtureResult => {
    const samplesByPass = new Map<string, number[]>();
    let finalAnalysis: PageObservationAnalysis | undefined;
    let finalObservation: PageObservation | undefined;

    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const observationStartedAt = performance.now();
        const observation = buildPageObservation(fixture.capture);
        appendSample(samplesByPass, 'observation', performance.now() - observationStartedAt);

        const analysis = analyzePageObservation(observation);
        for (const [passName, metrics] of Object.entries(analysis.report.passes)) {
            appendSample(samplesByPass, passName, metrics.durationMs);
        }
        finalObservation = observation;
        finalAnalysis = analysis;
    }

    if (!finalAnalysis || !finalObservation) {
        throw new Error(`fixture ${fixture.id} produced no laboratory samples`);
    }

    const quotientNodeIds = new Set(
        finalAnalysis.quotients.flatMap((view) => view.nodes.map((node) => node.nodeId)),
    );
    const canonicalNodeCount = Object.keys(finalObservation.nodes).length;
    const result: ObservationFixtureLaboratoryResult = {
        id: fixture.id,
        category: fixture.category,
        source: fixture.source,
        input: {
            nodeCount: fixture.capture.nodes.length,
            scopeCount: fixture.capture.scopes.length,
            accessibilityRecordCount: fixture.capture.accessibility.length,
            runtimeRecordCount: Object.keys(fixture.capture.runtimeState).length,
        },
        decision: {
            diagnosticCodes: countDiagnosticCodes(finalAnalysis),
            relationStatus: {
                resolved: finalAnalysis.relations.edges.filter((edge) => edge.status === 'resolved').length,
                unresolved: finalAnalysis.relations.edges.filter((edge) => edge.status === 'unresolved').length,
                ambiguous: finalAnalysis.relations.edges.filter((edge) => edge.status === 'ambiguous').length,
            },
            candidateCounts: { ...finalAnalysis.report.candidates },
            invariantOk: finalAnalysis.validation.ok,
        },
        workSet: {
            quotientCount: finalAnalysis.report.quotient.viewCount,
            maxSize: finalAnalysis.report.quotient.maxSize,
            p50Size: finalAnalysis.report.quotient.p50Size,
            p95Size: finalAnalysis.report.quotient.p95Size,
            maxCollapsedDepth: finalAnalysis.report.quotient.maxCollapsedDepth,
            maxProjectionParentFanOut: finalAnalysis.report.quotient.maxProjectionParentFanOut,
            orphanCount: finalAnalysis.report.quotient.orphanCount,
            unionRatio: canonicalNodeCount > 0 ? quotientNodeIds.size / canonicalNodeCount : 0,
            peakRetainedIndexEntries: countRetainedIndexEntries(finalObservation),
        },
        timing: Object.fromEntries(
            [...samplesByPass.entries()].map(([passName, samples]) => [passName, distribution(samples)]),
        ),
        truthErrors: validateFixtureTruth(fixture, finalAnalysis),
    };
    return {
        result,
        timingSamples: samplesByPass,
        quotientSizes: finalAnalysis.quotients.map((view) => view.nodes.length),
    };
};

const buildAggregate = (
    measuredFixtures: readonly MeasuredFixtureResult[],
): ObservationLaboratoryReport['aggregate'] => {
    const fixtures = measuredFixtures.map((fixture) => fixture.result);
    const quotientSizes = measuredFixtures
        .flatMap((fixture) => [...fixture.quotientSizes])
        .sort((left, right) => left - right);
    const samplesByPass = new Map<string, number[]>();
    for (const fixture of measuredFixtures) {
        for (const [passName, samples] of fixture.timingSamples.entries()) {
            for (const sample of samples) {
                appendSample(samplesByPass, passName, sample);
            }
        }
    }

    const candidateCounts = createCandidateCounts();
    for (const fixture of fixtures) {
        for (const classification of Object.keys(candidateCounts) as CandidateClassification[]) {
            candidateCounts[classification] += fixture.decision.candidateCounts[classification];
        }
    }

    return {
        inputNodeCount: sum(fixtures.map((fixture) => fixture.input.nodeCount)),
        relationEdgeCount: sum(fixtures.map((fixture) =>
            Object.values(fixture.decision.relationStatus).reduce((total, count) => total + count, 0))),
        candidateCounts,
        workSet: {
            maxSize: maximum(fixtures.map((fixture) => fixture.workSet.maxSize)),
            p50Size: percentile(quotientSizes, 0.5),
            p95Size: percentile(quotientSizes, 0.95),
            orphanCount: sum(fixtures.map((fixture) => fixture.workSet.orphanCount)),
            maximumUnionRatio: maximum(fixtures.map((fixture) => fixture.workSet.unionRatio)),
            peakRetainedIndexEntries: maximum(
                fixtures.map((fixture) => fixture.workSet.peakRetainedIndexEntries),
            ),
        },
        timing: Object.fromEntries(
            [...samplesByPass.entries()].map(([passName, samples]) => [passName, distribution(samples)]),
        ),
    };
};

const validateFixtureMetadata = (fixture: ObservationFixture, fixturePath: string) => {
    if (fixture.fixtureVersion !== 1) {
        throw new Error(`unsupported fixture version in ${fixturePath}`);
    }
    if (!fixture.id || !fixture.category || !fixture.source?.frameworkVersion) {
        throw new Error(`incomplete fixture metadata in ${fixturePath}`);
    }
    if (fixture.capture.metadata.schemaVersion !== 1) {
        throw new Error(`unsupported raw capture schema in ${fixturePath}`);
    }
};

const validateFixtureTruth = (
    fixture: ObservationFixture,
    analysis: PageObservationAnalysis,
): string[] => {
    const errors: string[] = [];
    if (fixture.truth.minimumScopeCount !== undefined
        && Object.keys(analysis.observation.scopes.scopes).length < fixture.truth.minimumScopeCount) {
        errors.push(`expected at least ${fixture.truth.minimumScopeCount} scopes`);
    }
    for (const expectedScope of fixture.truth.expectedScopeStatuses ?? []) {
        const matched = Object.values(analysis.observation.scopes.scopes).some((scope) =>
            scope.kind === expectedScope.kind && scope.status === expectedScope.status);
        if (!matched) {
            errors.push(`missing ${expectedScope.kind}:${expectedScope.status} scope`);
        }
    }
    const diagnosticCodes = new Set(analysis.diagnostics.map((diagnostic) => diagnostic.code));
    for (const expectedCode of fixture.truth.expectedDiagnosticCodes ?? []) {
        if (!diagnosticCodes.has(expectedCode)) {
            errors.push(`missing diagnostic ${expectedCode}`);
        }
    }
    validateExpectedCounts(
        'join',
        fixture.truth.expectedJoinCounts,
        analysis.report.joins,
        errors,
    );
    validateExpectedCounts(
        'relation',
        fixture.truth.expectedRelationCounts,
        analysis.report.relations,
        errors,
    );
    for (const [classification, expectedMinimum] of Object.entries(
        fixture.truth.expectedCandidateMinimums ?? {},
    ) as Array<[CandidateClassification, number]>) {
        if (analysis.report.candidates[classification] < expectedMinimum) {
            errors.push(`candidate ${classification} below ${expectedMinimum}`);
        }
    }
    if (fixture.truth.expectedOrphanCount !== undefined
        && analysis.report.quotient.orphanCount !== fixture.truth.expectedOrphanCount) {
        errors.push(`expected orphan count ${fixture.truth.expectedOrphanCount}`);
    }
    return errors;
};

const validateExpectedCounts = (
    label: string,
    expected: Readonly<Record<string, number>> | undefined,
    actual: Readonly<Record<string, number>>,
    errors: string[],
) => {
    for (const [name, expectedValue] of Object.entries(expected ?? {})) {
        if (actual[name] !== expectedValue) {
            errors.push(`${label} ${name} expected ${expectedValue}, got ${actual[name] ?? 'missing'}`);
        }
    }
};

const countDiagnosticCodes = (
    analysis: PageObservationAnalysis,
): Record<string, number> => {
    const result: Record<string, number> = {};
    for (const diagnostic of analysis.diagnostics) {
        result[diagnostic.code] = (result[diagnostic.code] ?? 0) + 1;
    }
    return result;
};

const countRetainedIndexEntries = (observation: PageObservation): number => {
    const indexRecords: Array<Readonly<Record<string, unknown>>> = [
        observation.nodes,
        observation.parents,
        observation.children,
        observation.documentOrder,
        observation.attributes,
        observation.text,
        observation.accessibility,
        observation.runtimeState,
        observation.geometry,
        observation.activity,
        observation.domIdentity,
        observation.layers,
        observation.captureIdToNodeId,
    ];
    return indexRecords.reduce((total, index) => total + Object.keys(index).length, 0);
};

const appendSample = (samplesByPass: Map<string, number[]>, passName: string, sample: number) => {
    const samples = samplesByPass.get(passName) ?? [];
    samples.push(sample);
    samplesByPass.set(passName, samples);
};

const distribution = (samples: readonly number[]): TimingDistribution => {
    const sorted = [...samples].sort((left, right) => left - right);
    return {
        samples: sorted.length,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(maximum(sorted)),
    };
};

const percentile = (sortedValues: readonly number[], ratio: number): number => {
    if (sortedValues.length === 0) {return 0;}
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
    );
    return sortedValues[index] ?? 0;
};

const maximum = (values: readonly number[]): number => values.length > 0 ? Math.max(...values) : 0;
const sum = (values: readonly number[]): number => values.reduce((total, value) => total + value, 0);
const round = (value: number): number => Math.round(value * 1000) / 1000;
const createCandidateCounts = (): Record<CandidateClassification, number> => ({
    structural: 0,
    host: 0,
    part: 0,
    latent: 0,
    rejected: 0,
    ambiguous: 0,
});
