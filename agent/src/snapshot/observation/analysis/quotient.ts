import type {
    ObservationPassCounter,
    ObservationNodeId,
    PageObservation,
} from '../model/contracts';
import type { RelationIndex } from '../../indexes/relation/contracts';
import type {
    CandidateEvidence,
    QuotientNode,
    StructuralQuotientView,
} from './contracts';

export const buildCandidateQuotientViews = (
    observation: PageObservation,
    relations: RelationIndex,
    candidates: readonly CandidateEvidence[],
    counter?: ObservationPassCounter,
): StructuralQuotientView[] => {
    const candidateByNodeId = new Map(candidates.map((candidate) => [candidate.anchorNodeId, candidate] as const));
    return candidates
        .filter((candidate) => shouldBuildView(observation, candidate, candidateByNodeId, counter))
        .map((candidate) => buildCandidateQuotientView(observation, relations, candidate, counter));
};

export const buildCandidateQuotientView = (
    observation: PageObservation,
    relations: RelationIndex,
    candidate: CandidateEvidence,
    counter?: ObservationPassCounter,
): StructuralQuotientView => {
    const localNodeIds = collectSubtreeNodeIds(observation, candidate.anchorNodeId, counter);
    const relationEndpointIds = collectRelationEndpointIds(relations, localNodeIds, counter);
    const retainedNodeIds = selectRetainedNodes(
        observation,
        candidate.anchorNodeId,
        localNodeIds,
        relationEndpointIds,
        counter,
    );
    return {
        scopeId: candidate.scopeId,
        candidateAnchorNodeId: candidate.anchorNodeId,
        nodes: buildQuotientNodes(observation, retainedNodeIds, candidate.anchorNodeId, counter),
    };
};

const shouldBuildView = (
    observation: PageObservation,
    candidate: CandidateEvidence,
    candidateByNodeId: ReadonlyMap<ObservationNodeId, CandidateEvidence>,
    counter?: ObservationPassCounter,
): boolean => {
    if (counter) {counter.nodeVisits += 1;}
    if (candidate.classification === 'rejected' || candidate.classification === 'part') {return false;}
    if (candidate.classification === 'latent' && candidate.kind === 'part') {return false;}
    if (candidate.classification !== 'structural' || !candidate.kind) {return true;}
    let parentNodeId = observation.parents[candidate.anchorNodeId];
    while (parentNodeId) {
        if (counter) {counter.nodeVisits += 1;}
        const parentCandidate = candidateByNodeId.get(parentNodeId);
        if (parentCandidate?.classification === 'host' && parentCandidate.kind === candidate.kind) {
            return false;
        }
        parentNodeId = observation.parents[parentNodeId];
    }
    return true;
};

const collectSubtreeNodeIds = (
    observation: PageObservation,
    anchorNodeId: ObservationNodeId,
    counter?: ObservationPassCounter,
): Set<ObservationNodeId> => {
    const result = new Set<ObservationNodeId>();
    const stack: ObservationNodeId[] = [anchorNodeId];
    while (stack.length > 0) {
        const nodeId = stack.pop();
        if (!nodeId || result.has(nodeId)) {continue;}
        if (counter) {counter.nodeVisits += 1;}
        result.add(nodeId);
        const children = observation.children[nodeId] ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {stack.push(children[index]);}
    }
    return result;
};

const collectRelationEndpointIds = (
    relations: RelationIndex,
    localNodeIds: ReadonlySet<ObservationNodeId>,
    counter?: ObservationPassCounter,
): Set<ObservationNodeId> => {
    const endpoints = new Set<ObservationNodeId>();
    const edgeIndexes = new Set<number>();
    for (const nodeId of localNodeIds) {
        for (const edgeIndex of relations.bySourceNodeId[nodeId] ?? []) {edgeIndexes.add(edgeIndex);}
        for (const edgeIndex of relations.byTargetNodeId[nodeId] ?? []) {edgeIndexes.add(edgeIndex);}
    }
    for (const edgeIndex of edgeIndexes) {
        if (counter) {counter.edgeVisits += 1;}
        const edge = relations.edges.at(edgeIndex);
        if (!edge) {continue;}
        endpoints.add(edge.sourceNodeId);
        edge.targetNodeIds.forEach((nodeId) => endpoints.add(nodeId));
    }
    return endpoints;
};

const selectRetainedNodes = (
    observation: PageObservation,
    anchorNodeId: ObservationNodeId,
    localNodeIds: ReadonlySet<ObservationNodeId>,
    relationEndpointIds: ReadonlySet<ObservationNodeId>,
    counter?: ObservationPassCounter,
): Set<ObservationNodeId> => {
    const retained = new Set<ObservationNodeId>([anchorNodeId]);
    for (const nodeId of localNodeIds) {
        if (counter) {counter.nodeVisits += 1;}
        if (relationEndpointIds.has(nodeId) || isSemanticallyRelevant(observation, nodeId)) {
            retained.add(nodeId);
        }
    }
    for (const endpointId of relationEndpointIds) {
        if (Object.hasOwn(observation.nodes, endpointId)) {retained.add(endpointId);}
    }
    return retained;
};

const buildQuotientNodes = (
    observation: PageObservation,
    retainedNodeIds: ReadonlySet<ObservationNodeId>,
    anchorNodeId: ObservationNodeId,
    counter?: ObservationPassCounter,
): QuotientNode[] => [...retainedNodeIds]
    .sort((left, right) => compareDocumentOrder(observation, left, right))
    .map((nodeId) => {
        if (counter) {counter.nodeVisits += 1;}
        const collapsedAncestorIds: ObservationNodeId[] = [];
        let cursor = observation.parents[nodeId];
        let projectionParentId: ObservationNodeId | undefined;
        while (cursor) {
            if (counter) {counter.nodeVisits += 1;}
            if (retainedNodeIds.has(cursor)) {projectionParentId = cursor; break;}
            collapsedAncestorIds.push(cursor);
            cursor = observation.parents[cursor];
        }
        if (nodeId === anchorNodeId) {
            projectionParentId = undefined;
            collapsedAncestorIds.length = 0;
        } else if (!projectionParentId && !isAncestorOrSelf(observation, anchorNodeId, nodeId, counter)) {
            projectionParentId = anchorNodeId;
            collapsedAncestorIds.length = 0;
        }
        return { nodeId, projectionParentId, collapsedAncestorIds };
    });

const isSemanticallyRelevant = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    if (!Object.hasOwn(observation.nodes, nodeId)) {return false;}
    const node = observation.nodes[nodeId];
    const attributes = observation.attributes[nodeId] ?? {};
    if (SEMANTIC_TAGS.has(node.tag)) {return true;}
    if (normalize(attributes.role) || normalize(attributes.id)) {return true;}
    if (observation.accessibility[nodeId] || observation.runtimeState[nodeId]) {return true;}
    const hasText = Boolean(normalize(observation.text[nodeId]));
    return hasText && (observation.children[nodeId].length === 0 || INTERACTIVE_TAGS.has(node.tag));
};

const isAncestorOrSelf = (
    observation: PageObservation,
    ancestorNodeId: ObservationNodeId,
    nodeId: ObservationNodeId,
    counter?: ObservationPassCounter,
): boolean => {
    let cursor: ObservationNodeId | undefined = nodeId;
    const visited = new Set<ObservationNodeId>();
    while (cursor && !visited.has(cursor)) {
        if (counter) {counter.nodeVisits += 1;}
        if (cursor === ancestorNodeId) {return true;}
        visited.add(cursor);
        cursor = observation.parents[cursor];
    }
    return false;
};

const compareDocumentOrder = (observation: PageObservation, left: ObservationNodeId, right: ObservationNodeId): number =>
    (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);
const normalize = (value: string | undefined): string => (value ?? '').trim();
const SEMANTIC_TAGS = new Set([
    'form', 'table', 'dialog', 'button', 'input', 'select', 'textarea', 'a', 'label',
    'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'colgroup',
]);
const INTERACTIVE_TAGS = new Set(['button', 'input', 'select', 'textarea', 'a']);
