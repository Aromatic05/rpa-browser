import type { FormComponent, FormSnapshot } from '../../components/form/model/contracts';
import type { ObservationNodeId } from '../../observation/model/contracts';
import type {
    EntityRuleQueryBinding,
    EntityRuleQueryPlan,
    QueryPlanDiagnostic,
} from './contracts';
import {
    cardinality,
    cardinalityDiagnostic,
    compareNodeOrder,
    descendants,
    isActiveNode,
    matchCommonNodeAttributes,
    nodeSearchText,
    normalize,
    normalizeLower,
    nodeContainsAll,
    orderedNodeIds,
    structureDiagnostic,
    unique,
} from './shared';

export const executeFormQueryPlan = (
    plan: EntityRuleQueryPlan,
    snapshot: FormSnapshot,
): { byRuleId: Record<string, EntityRuleQueryBinding>; diagnostics: QueryPlanDiagnostic[] } => {
    const byRuleId: Record<string, EntityRuleQueryBinding> = {};
    const diagnostics: QueryPlanDiagnostic[] = [];
    for (const step of plan.steps) {
        const within = step.withinRuleId ? byRuleId[step.withinRuleId] : undefined;
        const allowedNodeIds = step.withinRuleId ? buildWithinNodeSet(snapshot, within) : undefined;
        const contained = step.containsRuleId ? byRuleId[step.containsRuleId] : undefined;
        const containedNodeIds = step.containsRuleId && contained?.ok ? contained.matchedNodeIds : [];
        const matchedComponentIds: string[] = [];
        const matchedNodeIds: ObservationNodeId[] = [];
        const structuralDiagnostics: QueryPlanDiagnostic[] = [];
        if (step.source === 'node') {
            for (const nodeId of orderedNodeIds(snapshot.observation)) {
                if (!isActiveNode(snapshot.observation, nodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(nodeId)) {continue;}
                if (step.containsRuleId && !nodeContainsAll(snapshot.observation, nodeId, containedNodeIds)) {continue;}
                if (!step.match.kind && matchCommonNodeAttributes(snapshot.observation, nodeId, step, true)) {
                    matchedNodeIds.push(nodeId);
                }
            }
        } else {
            for (const form of orderedForms(snapshot)) {
                const rootNodeId = form.location.structuralRootNodeId;
                if (!isActiveNode(snapshot.observation, rootNodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(rootNodeId)) {continue;}
                if (step.containsRuleId && !nodeContainsAll(snapshot.observation, rootNodeId, containedNodeIds)) {continue;}
                if (!matchesForm(snapshot, form, step)) {continue;}
                matchedComponentIds.push(form.id);
                matchedNodeIds.push(rootNodeId);
                if (form.status !== 'complete') {
                    structuralDiagnostics.push(structureDiagnostic(
                        plan.profileName,
                        step,
                        'form-component',
                        form.status,
                        [rootNodeId],
                        form.evidence,
                    ));
                }
            }
        }
        const matchedFieldIds = step.source === 'node'
            ? fieldsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.forms.forms[componentId].fields.map((field) => field.id)));
        const matchedActionIds = step.source === 'node'
            ? actionsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.forms.forms[componentId].actions.map((action) => action.id)));
        const count = step.source === 'node' ? matchedNodeIds.length : matchedComponentIds.length;
        const binding: EntityRuleQueryBinding = {
            planStepId: step.planStepId,
            ruleId: step.ruleId,
            domain: 'form',
            source: step.source,
            expect: step.expect,
            targetKind: step.source === 'node' ? 'node' : 'form-component',
            matchedComponentIds,
            matchedNodeIds: unique(matchedNodeIds),
            matchedFieldIds,
            matchedActionIds,
            matchedRowIds: [],
            matchedColumnIds: [],
            cardinality: cardinality(step.expect, count),
            ok: false,
        };
        binding.ok = binding.cardinality.status === 'satisfied' && structuralDiagnostics.length === 0;
        byRuleId[step.ruleId] = binding;
        diagnostics.push(...structuralDiagnostics);
        const cardinalityFailure = cardinalityDiagnostic(plan.profileName, step, binding);
        if (cardinalityFailure) {diagnostics.push(cardinalityFailure);}
    }
    return { byRuleId, diagnostics };
};

const matchesForm = (
    snapshot: FormSnapshot,
    form: FormComponent,
    step: EntityRuleQueryPlan['steps'][number],
): boolean => {
    if (step.match.kind && step.match.kind !== 'form') {return false;}
    const rootNodeId = form.location.structuralRootNodeId;
    const attributes = snapshot.observation.attributes[rootNodeId] ?? {};
    if (!matchCommonNodeAttributes(snapshot.observation, rootNodeId, step, false)) {return false;}
    if (step.match.nameContains
        && !normalizeLower(formName(snapshot, form)).includes(normalizeLower(step.match.nameContains))) {
        return false;
    }
    if (step.match.idEquals && normalize(attributes.id) !== normalize(step.match.idEquals)) {return false;}
    return true;
};

const buildWithinNodeSet = (
    snapshot: FormSnapshot,
    binding: EntityRuleQueryBinding | undefined,
): Set<ObservationNodeId> => {
    if (!binding?.ok) {return new Set();}
    const output = new Set<ObservationNodeId>();
    for (const nodeId of binding.matchedNodeIds) {
        output.add(nodeId);
        descendants(snapshot.observation, nodeId).forEach((descendantId) => output.add(descendantId));
    }
    for (const componentId of binding.matchedComponentIds) {
        const form = snapshot.forms.forms[componentId];
        output.add(form.location.structuralRootNodeId);
        descendants(snapshot.observation, form.location.structuralRootNodeId)
            .forEach((nodeId) => output.add(nodeId));
        form.fields.forEach((field) => { field.memberNodeIds.forEach((nodeId) => output.add(nodeId)); });
        form.actions.forEach((action) => output.add(action.nodeId));
    }
    return output;
};

const fieldsForNodes = (snapshot: FormSnapshot, nodeIds: readonly ObservationNodeId[]): string[] => {
    const nodeSet = new Set(nodeIds);
    return Object.values(snapshot.forms.fields)
        .filter((field) => field.memberNodeIds.some((nodeId) => nodeSet.has(nodeId)))
        .map((field) => field.id);
};

const actionsForNodes = (snapshot: FormSnapshot, nodeIds: readonly ObservationNodeId[]): string[] => {
    const nodeSet = new Set(nodeIds);
    return Object.values(snapshot.forms.actions)
        .filter((action) => nodeSet.has(action.nodeId))
        .map((action) => action.id);
};

const formName = (snapshot: FormSnapshot, form: FormComponent): string => {
    const direct = nodeSearchText(snapshot.observation, form.location.structuralRootNodeId, false);
    if (direct) {return direct;}
    return form.fields.flatMap((field) => field.labelNodeIds)
        .map((nodeId) => nodeSearchText(snapshot.observation, nodeId, false))
        .filter(Boolean)
        .join(' ');
};

const orderedForms = (snapshot: FormSnapshot): FormComponent[] => Object.values(snapshot.forms.forms)
    .sort((left, right) => compareNodeOrder(
        snapshot.observation,
        left.location.structuralRootNodeId,
        right.location.structuralRootNodeId,
    ));
