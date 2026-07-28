import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationNodeId,
    ObservationPassCounter,
    PageObservation,
    RelationEdge,
    RelationIndex,
    RelationKind,
    TreeScopeId,
} from '../observation/contracts';
import { deepFreeze } from '../observation/freeze';
import { resolveSemanticRole } from '../observation/semantic';

const IDREF_RELATIONS: ReadonlyArray<{ attribute: string; kind: RelationKind }> = [
    { attribute: 'aria-labelledby', kind: 'labelled-by' },
    { attribute: 'aria-describedby', kind: 'described-by' },
    { attribute: 'aria-controls', kind: 'controls-target' },
    { attribute: 'aria-owns', kind: 'owns' },
    { attribute: 'form', kind: 'form-owner' },
];

export const buildRelationIndex = (
    observation: PageObservation,
    counter?: ObservationPassCounter,
): RelationIndex => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const edges: RelationEdge[] = [];
    const bySourceNodeId: Record<ObservationNodeId, number[]> = {};
    const byTargetNodeId: Record<ObservationNodeId, number[]> = {};
    const idIndex = buildScopeLocalDomIdIndex(observation, counter);

    for (const sourceNodeId of orderedNodeIds(observation)) {
        if (counter) {counter.nodeVisits += 1;}
        const attributes = observation.attributes[sourceNodeId] ?? {};
        const sourceNode = observation.nodes[sourceNodeId];
        if (!sourceNode) {continue;}
        for (const definition of IDREF_RELATIONS) {
            const rawValue = normalize(attributes[definition.attribute]);
            if (!rawValue) {continue;}
            const requestedIds = splitIdRefs(rawValue);
            const resolution = resolveIdRefs(sourceNode.scopeId, requestedIds, idIndex, observation);
            const edge: RelationEdge = {
                kind: definition.kind,
                sourceNodeId,
                targetNodeIds: resolution.targetNodeIds,
                status: resolution.status,
                evidence: [createIdRefEvidence(
                    definition.attribute,
                    sourceNodeId,
                    resolution.targetNodeIds,
                    requestedIds,
                )],
            };
            appendEdge(edges, bySourceNodeId, byTargetNodeId, edge, counter);
            if (edge.status !== 'resolved') {
                diagnostics.push(createRelationResolutionDiagnostic(edge, requestedIds));
            }
            if (edge.kind === 'controls-target' && edge.status === 'resolved') {
                const popupOwner = derivePopupOwner(observation, edge);
                if (popupOwner) {
                    appendEdge(edges, bySourceNodeId, byTargetNodeId, popupOwner, counter);
                }
            }
        }
    }

    return deepFreeze({ edges, bySourceNodeId, byTargetNodeId, diagnostics });
};

const buildScopeLocalDomIdIndex = (
    observation: PageObservation,
    counter?: ObservationPassCounter,
): Map<TreeScopeId, Map<string, ObservationNodeId[]>> => {
    const result = new Map<TreeScopeId, Map<string, ObservationNodeId[]>>();
    for (const nodeId of orderedNodeIds(observation)) {
        if (counter) {counter.nodeVisits += 1;}
        const node = observation.nodes[nodeId];
        if (!node) {continue;}
        const domId = normalize(observation.attributes[nodeId]?.id);
        if (!domId) {continue;}
        const scopeIndex = result.get(node.scopeId) ?? new Map<string, ObservationNodeId[]>();
        const bucket = scopeIndex.get(domId) ?? [];
        bucket.push(nodeId);
        scopeIndex.set(domId, bucket);
        result.set(node.scopeId, scopeIndex);
    }
    return result;
};

const resolveIdRefs = (
    scopeId: TreeScopeId,
    requestedIds: readonly string[],
    idIndex: ReadonlyMap<TreeScopeId, ReadonlyMap<string, readonly ObservationNodeId[]>>,
    observation: PageObservation,
): { status: RelationEdge['status']; targetNodeIds: ObservationNodeId[] } => {
    const scopeIndex = idIndex.get(scopeId);
    const resolved: ObservationNodeId[] = [];
    let missing = false;
    let ambiguous = false;
    for (const requestedId of requestedIds) {
        const candidates = [...(scopeIndex?.get(requestedId) ?? [])]
            .sort((left, right) => compareDocumentOrder(observation, left, right));
        if (candidates.length === 0) {missing = true; continue;}
        if (candidates.length > 1) {ambiguous = true;}
        resolved.push(...candidates);
    }
    if (ambiguous) {return { status: 'ambiguous', targetNodeIds: unique(resolved) };}
    if (missing || resolved.length === 0) {return { status: 'unresolved', targetNodeIds: unique(resolved) };}
    return { status: 'resolved', targetNodeIds: unique(resolved) };
};

const derivePopupOwner = (
    observation: PageObservation,
    controlsEdge: RelationEdge,
): RelationEdge | undefined => {
    if (controlsEdge.targetNodeIds.length !== 1) {return undefined;}
    const targetNodeId = controlsEdge.targetNodeIds[0];
    const targetRole = resolveSemanticRole(observation, targetNodeId);
    if (!POPUP_TARGET_ROLES.has(targetRole.value)) {return undefined;}
    return {
        kind: 'popup-owner',
        sourceNodeId: controlsEdge.sourceNodeId,
        targetNodeIds: [targetNodeId],
        status: 'resolved',
        evidence: [
            ...controlsEdge.evidence,
            {
                code: 'relation.popup-owner.target-role',
                strength: targetRole.strength,
                source: targetRole.source,
                nodeIds: [controlsEdge.sourceNodeId, targetNodeId],
                detail: { targetRole: targetRole.value },
            },
        ],
    };
};

const appendEdge = (
    edges: RelationEdge[],
    bySourceNodeId: Record<ObservationNodeId, number[]>,
    byTargetNodeId: Record<ObservationNodeId, number[]>,
    edge: RelationEdge,
    counter?: ObservationPassCounter,
) => {
    const edgeIndex = edges.length;
    edges.push(edge);
    (bySourceNodeId[edge.sourceNodeId] ??= []).push(edgeIndex);
    for (const targetNodeId of edge.targetNodeIds) {
        (byTargetNodeId[targetNodeId] ??= []).push(edgeIndex);
    }
    if (counter) {counter.edgeVisits += 1;}
};

const createIdRefEvidence = (
    attribute: string,
    sourceNodeId: ObservationNodeId,
    targetNodeIds: readonly ObservationNodeId[],
    requestedIds: readonly string[],
): Evidence => ({
    code: `relation.idref.${attribute}`,
    strength: 'exact',
    source: 'dom',
    nodeIds: [sourceNodeId, ...targetNodeIds],
    detail: { requestedIds: [...requestedIds] },
});

const createRelationResolutionDiagnostic = (
    edge: RelationEdge,
    requestedIds: readonly string[],
): AnalysisDiagnostic => ({
    code: edge.status === 'ambiguous' ? 'relation.idref.ambiguous' : 'relation.idref.unresolved',
    severity: edge.status === 'ambiguous' ? 'warning' : 'info',
    stage: 'relation',
    status: edge.status === 'ambiguous' ? 'ambiguous' : 'partial',
    nodeIds: [edge.sourceNodeId, ...edge.targetNodeIds],
    evidence: [...edge.evidence],
    message: `${edge.kind} could not be resolved uniquely for ${requestedIds.join(' ')}`,
});

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((left, right) => compareDocumentOrder(observation, left, right));
const compareDocumentOrder = (observation: PageObservation, left: ObservationNodeId, right: ObservationNodeId): number =>
    (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);
const splitIdRefs = (value: string): string[] => unique(value.split(/\s+/).map((item) => item.trim()).filter(Boolean));
const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];
const normalize = (value: string | undefined): string => (value ?? '').trim();
const POPUP_TARGET_ROLES = new Set(['dialog', 'alertdialog', 'listbox', 'menu', 'tree', 'grid']);
