import type {
    Evidence,
    LocatorScopePath,
    ObservationNodeId,
    PageObservation,
    Resolution,
    TreeScope,
    TreeScopeId,
} from './contracts';

export const resolveLocatorScopePath = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): Resolution<LocatorScopePath> => {
    const node = observation.nodes[nodeId];
    if (!node) {
        return {
            status: 'missing',
            evidence: [scopeEvidence('locator.scope.node-missing', [nodeId])],
        };
    }

    const path: LocatorScopePath = [];
    const visited = new Set<TreeScopeId>();
    let scopeId: TreeScopeId | undefined = node.scopeId;

    while (scopeId) {
        if (visited.has(scopeId)) {
            return {
                status: 'ambiguous',
                candidates: [path],
                evidence: [scopeEvidence('locator.scope.cycle', [nodeId], { scopeId })],
            };
        }
        visited.add(scopeId);

        const scope: TreeScope | undefined = observation.scopes.scopes[scopeId];
        if (!scope) {
            return {
                status: 'missing',
                evidence: [scopeEvidence('locator.scope.missing', [nodeId], { scopeId })],
            };
        }
        if (!scope.parentScopeId) {break;}
        if (!scope.hostNodeId || !observation.nodes[scope.hostNodeId]) {
            return {
                status: 'missing',
                evidence: [scopeEvidence('locator.scope.host-missing', [nodeId], { scopeId })],
            };
        }

        path.push({
            kind: scope.kind === 'iframe' ? 'frame' : 'shadow',
            hostNodeId: scope.hostNodeId,
        });
        scopeId = scope.parentScopeId;
    }

    path.reverse();
    return {
        status: 'resolved',
        value: path,
        evidence: [scopeEvidence('locator.scope.resolved', [nodeId, ...path.map((step) => step.hostNodeId)])],
    };
};

const scopeEvidence = (
    code: string,
    nodeIds: ObservationNodeId[],
    detail?: Record<string, unknown>,
): Evidence => ({
    code,
    strength: 'exact',
    source: 'platform',
    nodeIds,
    detail,
});
