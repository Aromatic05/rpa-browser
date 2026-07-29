import type {ControlSnapshot} from '../../components/control/model/contracts';
import type {ObservationNodeId} from '../../observation/model/contracts';
import type {
    EntityRuleQueryBinding,
    EntityRuleQueryPlan,
    QueryPlanDiagnostic,
} from './contracts';
import {
    cardinality,
    cardinalityDiagnostic,
    descendants,
    isActiveNode,
    matchCommonNodeAttributes,
    normalizeLower,
    orderedNodeIds,
    unique,
} from './shared';
import {resolveSemanticRole} from '../../observation/model/semantic';

export const executeNodeQueryPlan = (
    plan: EntityRuleQueryPlan,
    snapshot: ControlSnapshot,
): {byRuleId: Record<string, EntityRuleQueryBinding>; diagnostics: QueryPlanDiagnostic[]} => {
    const byRuleId: Record<string, EntityRuleQueryBinding> = {};
    const diagnostics: QueryPlanDiagnostic[] = [];
    for (const step of plan.steps) {
        const parent = step.withinRuleId ? byRuleId[step.withinRuleId] : undefined;
        const allowed = step.withinRuleId ? withinNodes(snapshot, parent) : undefined;
        const matchedNodeIds = orderedNodeIds(snapshot.observation).filter((nodeId) =>
            isActiveNode(snapshot.observation, nodeId)
            && (!allowed || allowed.has(nodeId))
            && matchesNode(snapshot, nodeId, step));
        const binding: EntityRuleQueryBinding = {
            planStepId: step.planStepId,
            ruleId: step.ruleId,
            domain: 'node',
            source: step.source,
            expect: step.expect,
            targetKind: 'node',
            matchedComponentIds: [],
            matchedNodeIds: unique(matchedNodeIds),
            matchedFieldIds: [],
            matchedActionIds: [],
            matchedRowIds: [],
            matchedColumnIds: [],
            cardinality: cardinality(step.expect, matchedNodeIds.length),
            ok: false,
        };
        binding.ok = binding.cardinality.status === 'satisfied';
        byRuleId[step.ruleId] = binding;
        const failure = cardinalityDiagnostic(plan.profileName, step, binding);
        if (failure) {diagnostics.push(failure);}
    }
    return {byRuleId, diagnostics};
};

const matchesNode = (
    snapshot: ControlSnapshot,
    nodeId: ObservationNodeId,
    step: EntityRuleQueryPlan['steps'][number],
): boolean => {
    if (!matchCommonNodeAttributes(snapshot.observation, nodeId, step, true)) {return false;}
    return !step.match.kind || matchesEntityKind(snapshot, nodeId, step.match.kind);
};

const matchesEntityKind = (
    snapshot: ControlSnapshot,
    nodeId: ObservationNodeId,
    kind: NonNullable<EntityRuleQueryPlan['steps'][number]['match']['kind']>,
): boolean => {
    const node = snapshot.observation.nodes[nodeId];
    const role = normalizeLower(resolveSemanticRole(snapshot.observation, nodeId).value);
    const tag = normalizeLower(node.tag);
    if (kind === 'dialog') {return role === 'dialog' || role === 'alertdialog' || tag === 'dialog';}
    if (kind === 'list') {return ['list', 'listbox', 'menu', 'tree'].includes(role) || tag === 'ul' || tag === 'ol';}
    if (kind === 'panel') {
        return ['region', 'group', 'main', 'complementary'].includes(role)
            || ['section', 'article', 'aside', 'main'].includes(tag);
    }
    if (kind === 'toolbar') {return role === 'toolbar';}
    if (kind === 'kv') {return tag === 'dl';}
    return false;
};

const withinNodes = (
    snapshot: ControlSnapshot,
    binding: EntityRuleQueryBinding | undefined,
): Set<ObservationNodeId> => {
    if (!binding?.ok) {return new Set();}
    const output = new Set<ObservationNodeId>();
    for (const nodeId of binding.matchedNodeIds) {
        output.add(nodeId);
        descendants(snapshot.observation, nodeId).forEach((descendant) => output.add(descendant));
    }
    return output;
};
