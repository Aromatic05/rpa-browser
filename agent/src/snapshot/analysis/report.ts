import type {
    AnalysisDiagnostic,
    CandidateClassification,
    CandidateEvidence,
    ObservationPassMetrics,
    ObservationReport,
    PageObservation,
    RelationIndex,
    StructuralQuotientView,
    TreeScopeId,
} from '../observation/contracts';

export const buildObservationReport = (input: {
    observation: PageObservation;
    relations: RelationIndex;
    candidates: readonly CandidateEvidence[];
    quotients: readonly StructuralQuotientView[];
    diagnostics: readonly AnalysisDiagnostic[];
    passes: Readonly<Record<string, ObservationPassMetrics>>;
}): ObservationReport => {
    const nodeCountByScope = countNodesByScope(input.observation);
    const scopes = Object.values(input.observation.scopes.scopes);
    const quotientSizes = input.quotients.map((view) => view.nodes.length).sort((left, right) => left - right);
    const candidateCounts = createCandidateCounts();
    for (const candidate of input.candidates) {
        candidateCounts[candidate.classification] += 1;
    }

    return {
        identity: { ...input.observation.identity },
        completeness: { ...input.observation.completeness },
        scope: {
            totalCount: scopes.length,
            capturedCount: scopes.filter((scope) => scope.status === 'captured').length,
            unavailableCount: scopes.filter((scope) => scope.status === 'unavailable').length,
            capturedWithoutCandidateCount: countCapturedWithoutCandidates(input.observation, input.candidates),
            nodeCountByScope,
        },
        joins: {
            a11yResolved: Object.values(input.observation.accessibility).filter(Boolean).length,
            a11yMissing: countJoinMissing(input.observation, 'a11y'),
            a11yAmbiguous: countDiagnostics(input.observation.diagnostics, 'observation.join.a11y.ambiguous'),
            runtimeResolved: Object.values(input.observation.runtimeState).filter(Boolean).length,
            runtimeMissing: countJoinMissing(input.observation, 'runtime'),
            runtimeAmbiguous: countDiagnostics(input.observation.diagnostics, 'observation.join.runtime.ambiguous'),
        },
        relations: {
            edgeCount: input.relations.edges.length,
            resolvedCount: input.relations.edges.filter((edge) => edge.status === 'resolved').length,
            unresolvedCount: input.relations.edges.filter((edge) => edge.status === 'unresolved').length,
            ambiguousCount: input.relations.edges.filter((edge) => edge.status === 'ambiguous').length,
        },
        activity: {
            zeroBoxCount: Object.values(input.observation.activity).filter((facts) => !facts.selfHasBox).length,
            zeroBoxWithActiveDescendants: Object.values(input.observation.activity)
                .filter((facts) => !facts.selfHasBox && facts.subtreeActive).length,
            controllerMismatchCount: countDiagnostics(input.diagnostics, 'activity.controller-state-mismatch'),
        },
        candidates: candidateCounts,
        quotient: {
            viewCount: input.quotients.length,
            maxSize: quotientSizes.at(-1) ?? 0,
            p50Size: percentile(quotientSizes, 0.5),
            p95Size: percentile(quotientSizes, 0.95),
            maxCollapsedDepth: maximum(
                input.quotients.flatMap((view) => view.nodes.map((node) => node.collapsedAncestorIds.length)),
            ),
            maxProjectionParentFanOut: maximumProjectionParentFanOut(input.quotients),
            orphanCount: input.diagnostics.filter((diagnostic) =>
                diagnostic.code === 'invariant.quotient.orphan').length,
        },
        passes: { ...input.passes },
    };
};

const countNodesByScope = (observation: PageObservation): Record<TreeScopeId, number> => {
    const result: Record<TreeScopeId, number> = {};
    for (const node of Object.values(observation.nodes)) {
        result[node.scopeId] = (result[node.scopeId] ?? 0) + 1;
    }
    return result;
};

const countCapturedWithoutCandidates = (
    observation: PageObservation,
    candidates: readonly CandidateEvidence[],
): number => {
    const meaningfulCandidateCountByScope = new Map<TreeScopeId, number>();
    for (const candidate of candidates) {
        if (candidate.classification === 'rejected' || candidate.classification === 'latent') {continue;}
        meaningfulCandidateCountByScope.set(
            candidate.scopeId,
            (meaningfulCandidateCountByScope.get(candidate.scopeId) ?? 0) + 1,
        );
    }
    return Object.values(observation.scopes.scopes).filter((scope) =>
        scope.status === 'captured'
        && (meaningfulCandidateCountByScope.get(scope.id) ?? 0) === 0).length;
};

const countJoinMissing = (
    observation: PageObservation,
    source: 'a11y' | 'runtime',
): number => {
    const ambiguousCode = source === 'a11y'
        ? 'observation.join.a11y.ambiguous'
        : 'observation.join.runtime.ambiguous';
    const ambiguousNodeIds = new Set(
        observation.diagnostics
            .filter((diagnostic) => diagnostic.code === ambiguousCode)
            .flatMap((diagnostic) => diagnostic.nodeIds),
    );

    let count = 0;
    for (const nodeId of Object.keys(observation.nodes)) {
        if (ambiguousNodeIds.has(nodeId)) {continue;}
        if (source === 'a11y') {
            if (observation.domIdentity[nodeId]?.backendNodeId && !observation.accessibility[nodeId]) {
                count += 1;
            }
            continue;
        }
        if (observation.domIdentity[nodeId]?.runtimeIdentityToken && !observation.runtimeState[nodeId]) {
            count += 1;
        }
    }
    return count;
};

const createCandidateCounts = (): Record<CandidateClassification, number> => ({
    structural: 0,
    host: 0,
    part: 0,
    latent: 0,
    rejected: 0,
    ambiguous: 0,
});

const countDiagnostics = (
    diagnostics: readonly AnalysisDiagnostic[],
    code: string,
): number => diagnostics.filter((diagnostic) => diagnostic.code === code).length;

const percentile = (sortedValues: readonly number[], ratio: number): number => {
    if (sortedValues.length === 0) {return 0;}
    const index = Math.min(
        sortedValues.length - 1,
        Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
    );
    return sortedValues[index] ?? 0;
};

const maximum = (values: readonly number[]): number =>
    values.length > 0 ? Math.max(...values) : 0;

const maximumProjectionParentFanOut = (
    quotients: readonly StructuralQuotientView[],
): number => {
    let maximumFanOut = 0;
    for (const quotient of quotients) {
        const fanOut = new Map<string, number>();
        for (const node of quotient.nodes) {
            if (!node.projectionParentId) {continue;}
            const next = (fanOut.get(node.projectionParentId) ?? 0) + 1;
            fanOut.set(node.projectionParentId, next);
            maximumFanOut = Math.max(maximumFanOut, next);
        }
    }
    return maximumFanOut;
};
