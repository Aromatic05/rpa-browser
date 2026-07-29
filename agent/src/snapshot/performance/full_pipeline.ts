import {performance} from 'node:perf_hooks';
import {buildControlSnapshot} from '../components/control/assembly/build';
import {buildFormSnapshot} from '../components/form/assembly/build';
import {buildTableSnapshot} from '../components/table/assembly/build';
import {buildLocatorIndex} from '../indexes/locator/build';
import {buildRelationIndex} from '../indexes/relation/build';
import {buildPageObservation} from '../observation/model/build';
import type {ObservationFixture, TimingDistribution} from '../observation/replay/contracts';
import {buildAnnotatorProjection} from '../annotator/projection';
import {buildSnapshotProjection} from '../projection/build';
import {diffSnapshotProjection} from '../projection/diff';
import {compileEntityRuleQueryPlan} from '../rules/query/compiler';
import {executeEntityRuleQueryPlan} from '../rules/query/executor';
import {buildSemanticLayer} from '../rules/semantic/build';
import {PageSnapshotSessionStore} from '../session/store';
import type {PageSnapshotCapture} from '../session/contracts';

export const SNAPSHOT_FULL_PIPELINE_PASSES = [
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

export type SnapshotFullPipelinePass = typeof SNAPSHOT_FULL_PIPELINE_PASSES[number];

export type SnapshotFullPipelineBenchmarkReport = {
    schemaVersion: 1;
    generatedAt: string;
    corpusVersion: string;
    iterations: number;
    structure: {
        observationFixtureCount: number;
        businessCaseCount: number;
        inputNodeCount: number;
        controlCount: number;
        formCount: number;
        tableCount: number;
        rowCount: number;
        projectedNodeCount: number;
        annotatorTargetCount: number;
    };
    timing: Record<SnapshotFullPipelinePass, TimingDistribution>;
};

export type SnapshotFullPipelineBenchmarkInput = {
    observationFixtures: readonly ObservationFixture[];
    businessCases: ReadonlyArray<{id: string; capture: PageSnapshotCapture}>;
    iterations?: number;
    corpusVersion?: string;
    generatedAt?: string;
};

export const runSnapshotFullPipelineBenchmark = async (
    input: SnapshotFullPipelineBenchmarkInput,
): Promise<SnapshotFullPipelineBenchmarkReport> => {
    const iterations = Math.max(1, Math.floor(input.iterations ?? 20));
    const samples = new Map<SnapshotFullPipelinePass, number[]>(
        SNAPSHOT_FULL_PIPELINE_PASSES.map((pass) => [pass, []]),
    );
    const structure = {
        observationFixtureCount: input.observationFixtures.length,
        businessCaseCount: input.businessCases.length,
        inputNodeCount: 0,
        controlCount: 0,
        formCount: 0,
        tableCount: 0,
        rowCount: 0,
        projectedNodeCount: 0,
        annotatorTargetCount: 0,
    };

    for (const fixture of input.observationFixtures) {
        structure.inputNodeCount += fixture.capture.nodes.length;
        let finalCapture: PageSnapshotCapture | undefined;
        for (let iteration = 0; iteration < iterations; iteration += 1) {
            const observation = measure(samples, 'observation', () => buildPageObservation(fixture.capture));
            const relations = measure(samples, 'relation', () => buildRelationIndex(observation));
            const locators = measure(samples, 'locator', () => buildLocatorIndex(observation));
            const control = measure(samples, 'control', () => buildControlSnapshot({observation, relations, locators}));
            const form = measure(samples, 'form', () => buildFormSnapshot({
                observation,
                relations,
                locators,
                controls: control.controls,
            }));
            const table = measure(samples, 'table', () => buildTableSnapshot({
                observation,
                relations,
                locators,
                controls: control.controls,
            }));
            finalCapture = {control, form, table};
        }
        if (!finalCapture) {throw new Error(`fixture produced no samples: ${fixture.id}`);}
        structure.controlCount += Object.keys(finalCapture.control.controls.controls).length;
        structure.formCount += Object.keys(finalCapture.form.forms.forms).length;
        structure.tableCount += Object.keys(finalCapture.table.tables.tables).length;
        structure.rowCount += Object.keys(finalCapture.table.tables.rows).length;
    }

    for (const businessCase of input.businessCases) {
        structure.controlCount += Object.keys(businessCase.capture.control.controls.controls).length;
        structure.formCount += Object.keys(businessCase.capture.form.forms.forms).length;
        structure.tableCount += Object.keys(businessCase.capture.table.tables.tables).length;
        structure.rowCount += Object.keys(businessCase.capture.table.tables.rows).length;

        for (let iteration = 0; iteration < iterations; iteration += 1) {
            const compiled = measure(samples, 'query-plan-compile', () => compileEntityRuleQueryPlan({
                profileName: `${businessCase.id}-table`,
                domain: 'table',
                rules: [{
                    ruleId: 'root',
                    source: 'region',
                    expect: 'unique',
                    match: {kind: 'table'},
                }],
            }));
            if (!compiled.ok) {
                throw new Error(`benchmark query plan failed: ${JSON.stringify(compiled.diagnostics)}`);
            }
            const execution = measure(samples, 'query-plan-execute', () => executeEntityRuleQueryPlan(
                compiled.plan,
                {table: businessCase.capture.table},
                {purpose: 'runtime'},
            ));
            if (!execution.ok) {
                throw new Error(`benchmark query execution failed: ${JSON.stringify(execution.diagnostics)}`);
            }
            measure(samples, 'semantic-bindings', () => buildSemanticLayer({
                execution,
                annotations: [{
                    ruleId: 'root',
                    origin: 'confirmed',
                    businessTag: `benchmark.${businessCase.id}`,
                }],
                snapshots: {table: businessCase.capture.table},
            }));

            const store = new PageSnapshotSessionStore();
            const pageKey = {};
            const entry = await measureAsync(samples, 'page-session-compose', async () => await store.ensureFresh({
                pageKey,
                pageUrl: `https://benchmark.invalid/${businessCase.id}`,
                capture: async () => businessCase.capture,
            }));
            const full = measure(samples, 'projection-full', () => requireProjection(
                buildSnapshotProjection(entry, {mode: 'full'}),
            ));
            measure(samples, 'projection-overview', () => requireProjection(
                buildSnapshotProjection(entry, {mode: 'overview'}),
            ));
            const annotator = measure(samples, 'annotator-projection', () => buildAnnotatorProjection(entry));
            const current = changedProjection(full);
            measure(samples, 'semantic-diff', () => diffSnapshotProjection(current, full));

            if (iteration === iterations - 1) {
                structure.projectedNodeCount += countProjectionNodes(full.roots);
                structure.annotatorTargetCount += annotator.targets.length;
            }
        }
    }

    return {
        schemaVersion: 1,
        generatedAt: input.generatedAt ?? new Date().toISOString(),
        corpusVersion: input.corpusVersion ?? 'snapshot-v2-stage45-v1',
        iterations,
        structure,
        timing: Object.fromEntries(SNAPSHOT_FULL_PIPELINE_PASSES.map((pass) => [
            pass,
            distribution(samples.get(pass) ?? []),
        ])) as Record<SnapshotFullPipelinePass, TimingDistribution>,
    };
};

const measure = <T>(
    samples: Map<SnapshotFullPipelinePass, number[]>,
    pass: SnapshotFullPipelinePass,
    operation: () => T,
): T => {
    const startedAt = performance.now();
    const result = operation();
    appendSample(samples, pass, performance.now() - startedAt);
    return result;
};

const measureAsync = async <T>(
    samples: Map<SnapshotFullPipelinePass, number[]>,
    pass: SnapshotFullPipelinePass,
    operation: () => Promise<T>,
): Promise<T> => {
    const startedAt = performance.now();
    const result = await operation();
    appendSample(samples, pass, performance.now() - startedAt);
    return result;
};

const appendSample = (
    samples: Map<SnapshotFullPipelinePass, number[]>,
    pass: SnapshotFullPipelinePass,
    value: number,
): void => {
    samples.get(pass)?.push(value);
};

const requireProjection = (
    result: ReturnType<typeof buildSnapshotProjection>,
) => {
    if (!result.ok) {throw new Error(`benchmark projection failed: ${result.error.message}`);}
    return result.projection;
};

const changedProjection = (
    baseline: ReturnType<typeof requireProjection>,
): ReturnType<typeof requireProjection> => {
    const current = structuredClone(baseline);
    current.meta.captureRevision += 1;
    current.meta.snapshotId = `${current.meta.snapshotId}:changed`;
    const first = firstProjectionNode(current.roots);
    if (first) {first.text = `${first.text ?? ''} changed`.trim();}
    return current;
};

const firstProjectionNode = (
    roots: ReturnType<typeof requireProjection>['roots'],
): ReturnType<typeof requireProjection>['roots'][number] | undefined => roots[0];

const countProjectionNodes = (
    roots: ReturnType<typeof requireProjection>['roots'],
): number => roots.reduce((total, node) => total + 1 + countProjectionNodes(node.children), 0);

const distribution = (values: readonly number[]): TimingDistribution => {
    const sorted = [...values].sort((left, right) => left - right);
    return {
        samples: sorted.length,
        p50Ms: round(percentile(sorted, 0.5)),
        p95Ms: round(percentile(sorted, 0.95)),
        maxMs: round(sorted.at(-1) ?? 0),
    };
};

const percentile = (sorted: readonly number[], ratio: number): number => {
    if (sorted.length === 0) {return 0;}
    return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))];
};

const round = (value: number): number => Math.round(value * 1000) / 1000;
