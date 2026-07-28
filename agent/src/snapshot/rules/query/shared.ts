import type {
    ObservationNodeId,
    PageObservation,
} from '../../observation/model/contracts';
import { resolveSemanticRole } from '../../observation/model/semantic';
import type {
    EntityRuleQueryBinding,
    EntityRuleQueryPlanStep,
    QueryPlanCardinality,
    QueryPlanDiagnostic,
    QueryPlanTargetKind,
} from './contracts';

export const cardinality = (
    expected: EntityRuleQueryPlanStep['expect'],
    actual: number,
): QueryPlanCardinality => ({
    expected,
    actual,
    status: expected === 'unique'
        ? actual === 1 ? 'satisfied' : actual === 0 ? 'missing' : 'multiple'
        : actual >= 1 ? 'satisfied' : 'missing',
});

export const cardinalityDiagnostic = (
    profileName: string,
    step: EntityRuleQueryPlanStep,
    binding: EntityRuleQueryBinding,
): QueryPlanDiagnostic | undefined => {
    if (binding.cardinality.status === 'satisfied') {return undefined;}
    const multiple = binding.cardinality.status === 'multiple';
    return queryDiagnostic({
        profileName,
        step,
        code: multiple ? 'query-plan.cardinality.multiple' : 'query-plan.cardinality.missing',
        severity: 'warning',
        status: multiple ? 'ambiguous' : 'partial',
        targetKind: binding.targetKind,
        nodeIds: binding.matchedNodeIds,
        message: `query plan step ${step.planStepId} expected ${step.expect}, got ${binding.cardinality.actual}`,
    });
};

export const structureDiagnostic = (
    profileName: string,
    step: EntityRuleQueryPlanStep,
    targetKind: QueryPlanTargetKind,
    status: 'partial' | 'ambiguous' | 'rejected',
    nodeIds: ObservationNodeId[],
    evidence: QueryPlanDiagnostic['evidence'],
): QueryPlanDiagnostic => queryDiagnostic({
    profileName,
    step,
    code: 'query-plan.structure.incomplete',
    severity: 'error',
    status,
    targetKind,
    nodeIds,
    evidence,
    message: `query plan step ${step.planStepId} matched a ${status} structural target`,
});

export const queryDiagnostic = (input: {
    profileName: string;
    code: string;
    message: string;
    targetKind: QueryPlanTargetKind;
    step?: EntityRuleQueryPlanStep;
    severity?: QueryPlanDiagnostic['severity'];
    status?: QueryPlanDiagnostic['status'];
    nodeIds?: ObservationNodeId[];
    evidence?: QueryPlanDiagnostic['evidence'];
}): QueryPlanDiagnostic => ({
    code: input.code,
    severity: input.severity ?? 'error',
    stage: 'query-plan-execute',
    status: input.status ?? 'rejected',
    nodeIds: input.nodeIds ?? [],
    evidence: input.evidence ?? [],
    message: input.message,
    profileName: input.profileName,
    planStepId: input.step?.planStepId,
    ruleId: input.step?.ruleId,
    targetKind: input.targetKind,
});

export const matchCommonNodeAttributes = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    step: EntityRuleQueryPlanStep,
    includeNameContains: boolean,
): boolean => {
    const attributes = observation.attributes[nodeId] ?? {};
    if (step.match.idEquals && normalize(attributes.id) !== normalize(step.match.idEquals)) {return false;}
    if (step.match.nameEquals && normalize(attributes.name) !== normalize(step.match.nameEquals)) {return false;}
    if (step.match.roleEquals
        && normalizeLower(resolveSemanticRole(observation, nodeId).value) !== normalizeLower(step.match.roleEquals)) {
        return false;
    }
    if (step.match.classContains
        && !normalizeLower(attributes.class).includes(normalizeLower(step.match.classContains))) {
        return false;
    }
    if (step.match.textContains
        && !normalizeCompactLower(nodeSearchText(observation, nodeId, true))
            .includes(normalizeCompactLower(step.match.textContains))) {
        return false;
    }
    if (step.match.ariaContains) {
        const aria = normalizeLower([
            attributes['aria-label'],
            attributes['aria-labelledby'],
            attributes['aria-describedby'],
            attributes['aria-errormessage'],
            attributes.title,
        ].filter(Boolean).join(' '));
        if (!aria.includes(normalizeLower(step.match.ariaContains))) {return false;}
    }
    if (includeNameContains && step.match.nameContains
        && !normalizeLower(nodeSearchText(observation, nodeId, false)).includes(normalizeLower(step.match.nameContains))) {
        return false;
    }
    return true;
};

export const nodeSearchText = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    includeDescendants: boolean,
): string => {
    const nodeIds = includeDescendants ? [nodeId, ...descendants(observation, nodeId)] : [nodeId];
    return nodeIds.flatMap((id) => {
        const attributes = observation.attributes[id] ?? {};
        return [
            observation.accessibility[id]?.name,
            attributes['aria-label'],
            attributes.placeholder,
            attributes.title,
            attributes.name,
            observation.text[id],
        ];
    }).filter(Boolean).join(' ');
};

export const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] => Object.keys(observation.nodes)
    .sort((left, right) => compareNodeOrder(observation, left, right));

export const compareNodeOrder = (
    observation: PageObservation,
    left: ObservationNodeId,
    right: ObservationNodeId,
): number => (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);

export const descendants = (
    observation: PageObservation,
    rootNodeId: ObservationNodeId,
): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    const stack = [...(observation.children[rootNodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const nodeId = stack.pop();
        if (!nodeId) {continue;}
        output.push(nodeId);
        stack.push(...[...(observation.children[nodeId] ?? [])].reverse());
    }
    return output;
};

export const isActiveNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return Boolean(activity && activity.rendered && !activity.hiddenByStyle && !activity.inert
        && activity.subtreeActive && activity.ariaExposed !== false);
};

export const normalize = (value: string | undefined): string => (value ?? '').trim();
export const normalizeLower = (value: string | undefined): string => normalize(value).toLowerCase();
export const normalizeCompactLower = (value: string | undefined): string => normalizeLower(value).replace(/\s+/g, '');
export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
