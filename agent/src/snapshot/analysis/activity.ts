import type {
    AnalysisDiagnostic,
    ObservationNodeId,
    ObservationPassCounter,
    PageObservation,
    RelationIndex,
} from '../observation/contracts';

export const diagnoseActivityConsistency = (
    observation: PageObservation,
    relations: RelationIndex,
    counter?: ObservationPassCounter,
): AnalysisDiagnostic[] => {
    const diagnostics: AnalysisDiagnostic[] = [];
    for (const edge of relations.edges) {
        if (counter) {counter.edgeVisits += 1;}
        if (edge.kind !== 'controls-target' || edge.status !== 'resolved') {continue;}
        if (counter) {counter.nodeVisits += 1 + edge.targetNodeIds.length;}
        const controllerState = readControllerState(observation, edge.sourceNodeId);
        if (controllerState !== 'inactive') {continue;}
        const activeTargets = edge.targetNodeIds.filter((targetNodeId) =>
            observation.activity[targetNodeId]?.subtreeActive === true);
        if (activeTargets.length === 0) {continue;}
        diagnostics.push({
            code: 'activity.controller-state-mismatch',
            severity: 'warning',
            stage: 'activity',
            status: 'partial',
            nodeIds: [edge.sourceNodeId, ...activeTargets],
            evidence: [
                ...edge.evidence,
                {
                    code: 'activity.actual-target-active',
                    strength: 'strong',
                    source: 'geometry',
                    nodeIds: activeTargets,
                },
            ],
            message: 'controller reports an inactive state while its controlled target remains active',
        });
    }
    return diagnostics;
};

const readControllerState = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
): 'active' | 'inactive' | 'unknown' => {
    const runtimeState = observation.runtimeState[nodeId];
    const attributes = observation.attributes[nodeId] ?? {};
    const expanded = normalizeBoolean(runtimeState?.ariaExpanded ?? attributes['aria-expanded']);
    if (expanded !== undefined) {return expanded ? 'active' : 'inactive';}
    const selected = normalizeBoolean(runtimeState?.ariaSelected ?? attributes['aria-selected']);
    if (selected !== undefined) {return selected ? 'active' : 'inactive';}
    return 'unknown';
};

const normalizeBoolean = (value: string | undefined): boolean | undefined => {
    const normalized = (value ?? '').trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {return true;}
    if (['false', '0', 'no', 'off'].includes(normalized)) {return false;}
    return undefined;
};
