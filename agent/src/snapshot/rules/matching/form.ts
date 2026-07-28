import type {
    AnalysisDiagnostic,
    ObservationNodeId,
    PageObservation,
} from '../../observation/model/contracts';
import { deepFreeze } from '../../observation/model/freeze';
import { resolveSemanticRole } from '../../observation/model/semantic';
import type { FormComponent, FormField, FormSnapshot } from '../../components/form/model/contracts';
import { cardinalitySatisfied } from './cardinality';
import type {
    FormComponentMatchRule,
    FormComponentRuleBinding,
    FormComponentRuleMatchResult,
} from '../model/contracts';

export const matchFormComponentRules = (
    snapshot: FormSnapshot,
    rules: readonly FormComponentMatchRule[],
): FormComponentRuleMatchResult => {
    const byRuleId: Record<string, FormComponentRuleBinding> = {};
    const diagnostics: AnalysisDiagnostic[] = [];

    for (const rule of rules) {
        const within = rule.within ? byRuleId[rule.within] : undefined;
        const allowedNodeIds = rule.within ? buildWithinNodeSet(snapshot, within) : undefined;
        const matchedComponentIds: string[] = [];
        const matchedNodeIds: ObservationNodeId[] = [];

        if (rule.source === 'node') {
            for (const nodeId of orderedNodeIds(snapshot.observation)) {
                if (!isActiveNode(snapshot.observation, nodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(nodeId)) {continue;}
                if (matchesNode(snapshot.observation, nodeId, rule)) {matchedNodeIds.push(nodeId);}
            }
        } else {
            for (const form of orderedForms(snapshot)) {
                const rootNodeId = form.location.structuralRootNodeId;
                if (!isActiveNode(snapshot.observation, rootNodeId)) {continue;}
                if (allowedNodeIds && !allowedNodeIds.has(rootNodeId)) {continue;}
                if (!matchesForm(snapshot, form, rule)) {continue;}
                matchedComponentIds.push(form.id);
                matchedNodeIds.push(rootNodeId);
            }
        }

        const matchedFieldIds = rule.source === 'node'
            ? fieldsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.forms.forms[componentId]?.fields.map((field) => field.id) ?? []));
        const matchedActionIds = rule.source === 'node'
            ? actionsForNodes(snapshot, matchedNodeIds)
            : unique(matchedComponentIds.flatMap((componentId) =>
                snapshot.forms.forms[componentId]?.actions.map((action) => action.id) ?? []));
        const count = rule.source === 'node' ? matchedNodeIds.length : matchedComponentIds.length;
        const ok = cardinalitySatisfied(rule.expect, count);
        const binding: FormComponentRuleBinding = {
            ruleId: rule.ruleId,
            source: rule.source,
            expect: rule.expect,
            matchedComponentIds,
            matchedFieldIds,
            matchedActionIds,
            matchedNodeIds: unique(matchedNodeIds),
            ok,
        };
        byRuleId[rule.ruleId] = binding;
        if (!ok) {diagnostics.push(cardinalityDiagnostic(rule, binding));}
    }

    return deepFreeze({ byRuleId, diagnostics });
};

const matchesForm = (
    snapshot: FormSnapshot,
    form: FormComponent,
    rule: FormComponentMatchRule,
): boolean => {
    if (rule.match.kind && rule.match.kind !== 'form') {return false;}
    const rootNodeId = form.location.structuralRootNodeId;
    const attrs = snapshot.observation.attributes[rootNodeId] ?? {};
    if (!matchCommonNodeAttributes(snapshot.observation, rootNodeId, rule)) {return false;}
    if (rule.match.nameContains) {
        const name = normalizeLower(formName(snapshot, form));
        if (!name.includes(normalizeLower(rule.match.nameContains))) {return false;}
    }
    if (rule.match.idEquals && normalize(attrs.id) !== normalize(rule.match.idEquals)) {return false;}
    return true;
};

const matchesNode = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    rule: FormComponentMatchRule,
): boolean => {
    if (rule.match.kind) {return false;}
    return matchCommonNodeAttributes(observation, nodeId, rule);
};

const matchCommonNodeAttributes = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    rule: FormComponentMatchRule,
): boolean => {
    const attrs = observation.attributes[nodeId] ?? {};
    if (rule.match.idEquals && normalize(attrs.id) !== normalize(rule.match.idEquals)) {return false;}
    if (rule.match.nameEquals && normalize(attrs.name) !== normalize(rule.match.nameEquals)) {return false;}
    if (rule.match.roleEquals
        && normalizeLower(resolveSemanticRole(observation, nodeId).value) !== normalizeLower(rule.match.roleEquals)) {
        return false;
    }
    if (rule.match.classContains
        && !normalizeLower(attrs.class).includes(normalizeLower(rule.match.classContains))) {
        return false;
    }
    if (rule.match.textContains
        && !normalizeCompactLower(nodeName(observation, nodeId)).includes(normalizeCompactLower(rule.match.textContains))) {
        return false;
    }
    if (rule.match.ariaContains) {
        const aria = normalizeLower([
            attrs['aria-label'],
            attrs['aria-labelledby'],
            attrs['aria-describedby'],
            attrs['aria-errormessage'],
            attrs.title,
        ].filter(Boolean).join(' '));
        if (!aria.includes(normalizeLower(rule.match.ariaContains))) {return false;}
    }
    if (rule.match.nameContains
        && !normalizeLower(nodeName(observation, nodeId)).includes(normalizeLower(rule.match.nameContains))) {
        return false;
    }
    return true;
};

const buildWithinNodeSet = (
    snapshot: FormSnapshot,
    binding: FormComponentRuleBinding | undefined,
): Set<ObservationNodeId> => {
    if (!binding?.ok) {return new Set();}
    const output = new Set<ObservationNodeId>();
    for (const nodeId of binding.matchedNodeIds) {
        output.add(nodeId);
        for (const descendantId of descendants(snapshot.observation, nodeId)) {output.add(descendantId);}
    }
    for (const componentId of binding.matchedComponentIds) {
        const form = snapshot.forms.forms[componentId];
        if (!form) {continue;}
        output.add(form.location.structuralRootNodeId);
        for (const nodeId of descendants(snapshot.observation, form.location.structuralRootNodeId)) {output.add(nodeId);}
        for (const field of form.fields) {
            for (const nodeId of field.memberNodeIds) {output.add(nodeId);}
        }
        for (const action of form.actions) {output.add(action.nodeId);}
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

const isActiveNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return Boolean(activity && activity.rendered && !activity.hiddenByStyle && !activity.inert
        && activity.subtreeActive && activity.ariaExposed !== false);
};

const cardinalityDiagnostic = (
    rule: FormComponentMatchRule,
    binding: FormComponentRuleBinding,
): AnalysisDiagnostic => {
    const count = rule.source === 'node'
        ? binding.matchedNodeIds.length
        : binding.matchedComponentIds.length;
    const multiple = rule.expect === 'unique' && count > 1;
    return {
        code: multiple ? 'form.bridge.cardinality.multiple' : 'form.bridge.cardinality.missing',
        severity: 'warning',
        stage: 'form-bridge',
        status: multiple ? 'ambiguous' : 'partial',
        nodeIds: binding.matchedNodeIds,
        evidence: [],
        message: multiple
            ? `form bridge rule matched multiple structural targets: ${rule.ruleId}`
            : `form bridge rule matched no structural target: ${rule.ruleId}`,
    };
};

const formName = (snapshot: FormSnapshot, form: FormComponent): string => {
    const rootNodeId = form.location.structuralRootNodeId;
    const direct = nodeName(snapshot.observation, rootNodeId);
    if (direct) {return direct;}
    return form.fields.flatMap((field) => field.labelNodeIds)
        .map((nodeId) => nodeName(snapshot.observation, nodeId))
        .filter(Boolean)
        .join(' ');
};

const nodeName = (observation: PageObservation, nodeId: ObservationNodeId): string =>
    observation.accessibility[nodeId]?.name
    ?? observation.attributes[nodeId]?.['aria-label']
    ?? observation.attributes[nodeId]?.title
    ?? observation.text[nodeId]
    ?? '';

const orderedForms = (snapshot: FormSnapshot): FormComponent[] =>
    Object.values(snapshot.forms.forms).sort((left, right) =>
        compareNodeOrder(snapshot.observation, left.location.structuralRootNodeId, right.location.structuralRootNodeId));

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((left, right) => compareNodeOrder(observation, left, right));

const compareNodeOrder = (observation: PageObservation, left: ObservationNodeId, right: ObservationNodeId): number =>
    (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);

const descendants = (observation: PageObservation, nodeId: ObservationNodeId): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    const stack = [...(observation.children[nodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const current = stack.pop();
        if (!current) {continue;}
        output.push(current);
        const children = observation.children[current] ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {stack.push(children[index]);}
    }
    return output;
};

const normalize = (value: string | undefined): string => (value ?? '').trim();
const normalizeLower = (value: string | undefined): string => normalize(value).toLowerCase();
const normalizeCompactLower = (value: string | undefined): string => normalizeLower(value).replace(/\s+/g, '');
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
