import type {
    Locator } from 'playwright'; import type {     AnalysisDiagnostic,
    Evidence,
    LocatorScopePath,
    ObservationIdentity,
    ObservationNodeId,
    PageObservation,
} from '../../observation/model/contracts';

export type CanonicalLocatorStatus = 'resolved' | 'unresolved' | 'ambiguous';
export type CanonicalLocatorStrategy = 'id' | 'test-id' | 'name' | 'structural';

export type CanonicalLocator = {
    id: string;
    targetNodeId: ObservationNodeId;
    identity: ObservationIdentity;
    status: CanonicalLocatorStatus;
    strategy?: CanonicalLocatorStrategy;
    selector?: string;
    fingerprint?: string;
    scopePath: LocatorScopePath;
    evidence: Evidence[];
};

export type LocatorIndex = {
    locators: Readonly<Record<string, CanonicalLocator>>;
    byNodeId: Readonly<Record<ObservationNodeId, readonly string[]>>;
    diagnostics: readonly AnalysisDiagnostic[];
};


export type LocatorExecutionRefresh = () => Promise<{
    observation: PageObservation;
    index: LocatorIndex;
}>;

export type LocatorExecutionOptions = {
    refresh?: LocatorExecutionRefresh;
};

export type ExecutableLocatorResolution =
    | { status: 'resolved'; locator: Locator; evidence: Evidence[] }
    | { status: 'stale'; evidence: Evidence[]; message: string }
    | { status: 'ambiguous'; evidence: Evidence[]; message: string; count?: number }
    | { status: 'unresolved'; evidence: Evidence[]; message: string };
