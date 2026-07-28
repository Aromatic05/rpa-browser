import type {
    CandidateClassification,
    ObservationReport,
} from '../analysis/contracts';
import type { RawPageCapture } from '../model/raw_capture';

export type ObservationFixtureTruth = {
    minimumScopeCount?: number;
    expectedScopeStatuses?: Array<{
        kind: 'document' | 'iframe' | 'open-shadow-root';
        status: 'captured' | 'unavailable';
    }>;
    expectedDiagnosticCodes?: string[];
    expectedJoinCounts?: Partial<ObservationReport['joins']>;
    expectedRelationCounts?: Partial<ObservationReport['relations']>;
    expectedCandidateMinimums?: Partial<Record<CandidateClassification, number>>;
    expectedOrphanCount?: number;
};

export type ObservationFixture = {
    fixtureVersion: 1;
    id: string;
    category: string;
    source: {
        kind: 'fixed-raw-capture' | 'browser-capture';
        framework: 'native' | 'element-plus' | 'ant-design' | 'platform';
        frameworkVersion: string;
        capturedAt: string;
        origin: string;
    };
    truth: ObservationFixtureTruth;
    capture: RawPageCapture;
};

export type TimingDistribution = {
    samples: number;
    p50Ms: number;
    p95Ms: number;
    maxMs: number;
};

export type ObservationFixtureBenchmarkResult = {
    id: string;
    category: string;
    source: ObservationFixture['source'];
    input: {
        nodeCount: number;
        scopeCount: number;
        accessibilityRecordCount: number;
        runtimeRecordCount: number;
    };
    decision: {
        diagnosticCodes: Record<string, number>;
        relationStatus: Record<'resolved' | 'unresolved' | 'ambiguous', number>;
        candidateCounts: ObservationReport['candidates'];
        invariantOk: boolean;
    };
    workSet: {
        quotientCount: number;
        maxSize: number;
        p50Size: number;
        p95Size: number;
        maxCollapsedDepth: number;
        maxProjectionParentFanOut: number;
        orphanCount: number;
        unionRatio: number;
        peakRetainedIndexEntries: number;
    };
    timing: Record<string, TimingDistribution>;
    truthErrors: string[];
};

export type ObservationReplayBenchmarkReport = {
    schemaVersion: 1;
    generatedAt: string;
    corpusVersion: string;
    iterations: number;
    fixtureCount: number;
    fixtures: ObservationFixtureBenchmarkResult[];
    aggregate: {
        inputNodeCount: number;
        relationEdgeCount: number;
        candidateCounts: ObservationReport['candidates'];
        workSet: {
            maxSize: number;
            p50Size: number;
            p95Size: number;
            orphanCount: number;
            maximumUnionRatio: number;
            peakRetainedIndexEntries: number;
        };
        timing: Record<string, TimingDistribution>;
    };
};
