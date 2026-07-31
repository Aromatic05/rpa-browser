import type {
    AnchorResolution,
    Evidence,
    ObservationAnchor,
    ObservationNodeId,
    PageObservation,
} from './contracts';

export const createObservationAnchor = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): ObservationAnchor | undefined => {
    if (!Object.hasOwn(observation.nodes, nodeId) || !Object.hasOwn(observation.domIdentity, nodeId)) {
        return undefined;
    }
    const identity = observation.domIdentity[nodeId];
    return {
        pageEpoch: observation.identity.pageEpoch,
        captureRevision: observation.identity.captureRevision,
        nodeId,
        backendNodeId: identity.backendNodeId,
        runtimeIdentityToken: identity.runtimeIdentityToken,
    };
};

export const resolveObservationAnchor = (
    anchor: ObservationAnchor,
    observation: PageObservation,
): AnchorResolution => {
    if (anchor.pageEpoch !== observation.identity.pageEpoch) {
        return {
            status: 'stale',
            evidence: [anchorEvidence('anchor.page-epoch.changed', [], {
                anchorPageEpoch: anchor.pageEpoch,
                observationPageEpoch: observation.identity.pageEpoch,
            })],
        };
    }

    const exactCandidates = anchor.backendNodeId
        ? findByIdentity(observation, 'backendNodeId', anchor.backendNodeId)
        : anchor.runtimeIdentityToken
            ? findByIdentity(observation, 'runtimeIdentityToken', anchor.runtimeIdentityToken)
            : [];
    if (exactCandidates.length === 1) {
        return {
            status: 'resolved',
            nodeId: exactCandidates[0],
            evidence: [anchorEvidence(
                anchor.backendNodeId
                    ? 'anchor.backend-node-id.exact'
                    : 'anchor.runtime-identity-token.exact',
                exactCandidates,
            )],
        };
    }
    if (exactCandidates.length > 1) {
        return {
            status: 'ambiguous',
            candidateNodeIds: exactCandidates,
            evidence: [anchorEvidence('anchor.exact-identity.ambiguous', exactCandidates)],
        };
    }

    return {
        status: 'stale',
        evidence: [anchorEvidence('anchor.exact-identity.missing', [anchor.nodeId], {
            backendNodeId: anchor.backendNodeId,
            runtimeIdentityToken: anchor.runtimeIdentityToken,
        })],
    };
};

const findByIdentity = (
    observation: PageObservation,
    key: 'backendNodeId' | 'runtimeIdentityToken',
    value: string,
): ObservationNodeId[] => Object.keys(observation.nodes)
    .filter((nodeId) => Object.hasOwn(observation.domIdentity, nodeId)
        && observation.domIdentity[nodeId][key] === value)
    .sort((left, right) =>
        (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER));

const anchorEvidence = (
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
