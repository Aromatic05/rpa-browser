import type {
    AnalysisDiagnostic,
    AssemblyStatus,
    Evidence,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type {
    RelationEdge,
    RelationIndex,
} from '../../../indexes/relation/contracts';
import { deepFreeze } from '../../../observation/model/freeze';
import { resolveSemanticRole } from '../../../observation/model/semantic';
import type { ControlComponent, ControlIndex } from '../../control/model/contracts';
import type { LocatorIndex } from '../../../indexes/locator/contracts';
import {
    buildOwnershipIndex,
    ownershipEndpointKey,
    validateOwnershipIndex,
} from '../../../indexes/ownership/build';
import type { OwnershipEdge, OwnershipEndpoint } from '../../../indexes/ownership/contracts';
import type {
    BuildFormSnapshotInput,
    FormAction,
    FormBoundaryKind,
    FormComponent,
    FormComponentIndex,
    FormField,
    FormGroup,
    FormInvariantValidation,
    FormProposal,
    FormReductionState,
    FormReductionTraceRecord,
    FormSnapshot,
} from '../model/contracts';
import { reduceBottomUp } from './reducer';

const FIELD_CONTROL_KINDS = new Set([
    'input',
    'textarea',
    'native_select',
    'radio_group',
    'checkbox_group',
    'custom_select',
    'date_like',
]);
const ACTION_CONTROL_KINDS = new Set(['button', 'link']);
const FORM_CONTROL_TAGS = new Set(['input', 'select', 'textarea']);
const COMPOSITE_CLASS_PATTERN = /(^|[-_])(range|input-group|input-wrapper)([-_]|$)/;
const ELEMENT_FORM_ITEM = 'el-form-item';
const ANT_FORM_ITEM = 'ant-form-item';
const UTILITY_CLASSES = new Set([
    'dt-search',
    'dt-length',
    'datatables_filter',
    'datatables_length',
    'table-toolbar',
    'table-utility',
]);

export const buildFormSnapshot = (input: BuildFormSnapshotInput): FormSnapshot => ({
    observation: input.observation,
    relations: input.relations,
    locators: input.locators,
    controls: input.controls,
    forms: buildFormComponentIndex(input),
});

export const buildFormComponentIndex = (input: BuildFormSnapshotInput): FormComponentIndex => {
    const { observation, relations, controls } = input;
    const diagnostics: AnalysisDiagnostic[] = [];
    const fields: Record<string, FormField> = {};
    const groups: Record<string, FormGroup> = {};
    const actions: Record<string, FormAction> = {};
    const forms: Record<string, FormComponent> = {};
    const fieldIdsByAnchor = new Map<ObservationNodeId, string[]>();
    const forcedFieldIdsByBoundary = new Map<ObservationNodeId, string[]>();
    const actionIdsByNode = new Map<ObservationNodeId, string[]>();
    const forcedActionIdsByBoundary = new Map<ObservationNodeId, string[]>();
    const standaloneFieldIds = new Set<string>();
    const reductionTrace: FormReductionTraceRecord[] = [];

    const fieldControls = Object.values(controls.controls)
        .filter((control) => FIELD_CONTROL_KINDS.has(control.kind))
        .sort((left, right) => compareNodeOrder(observation, left.rootNodeId, right.rootNodeId));
    const controlsByAnchor = new Map<ObservationNodeId, ControlComponent[]>();
    for (const control of fieldControls) {
        const anchorNodeId = findFieldAnchor(observation, control, fieldControls);
        const bucket = controlsByAnchor.get(anchorNodeId) ?? [];
        bucket.push(control);
        controlsByAnchor.set(anchorNodeId, bucket);
    }

    for (const [anchorNodeId, anchorControls] of controlsByAnchor) {
        const field = buildField(observation, relations, controls, anchorNodeId, anchorControls, groups);
        fields[field.id] = field;
        if (isUtilityContainer(observation, anchorNodeId) || isTableContainer(observation, anchorNodeId)) {
            standaloneFieldIds.add(field.id);
        }
        diagnostics.push(...field.diagnostics);
        const owner = resolveFormOwner(observation, relations, anchorControls);
        if (owner.status === 'ambiguous' || owner.status === 'invalid') {
            diagnostics.push(formOwnerDiagnostic(anchorControls, owner.candidateNodeIds, owner.status));
        }
        if (owner.status === 'resolved') {
            const bucket = forcedFieldIdsByBoundary.get(owner.ownerNodeId) ?? [];
            bucket.push(field.id);
            forcedFieldIdsByBoundary.set(owner.ownerNodeId, bucket);
        } else {
            const bucket = fieldIdsByAnchor.get(anchorNodeId) ?? [];
            bucket.push(field.id);
            fieldIdsByAnchor.set(anchorNodeId, bucket);
        }
    }

    for (const control of Object.values(controls.controls)
        .filter((candidate) => ACTION_CONTROL_KINDS.has(candidate.kind))
        .sort((left, right) => compareNodeOrder(observation, left.rootNodeId, right.rootNodeId))) {
        const action = buildAction(observation, control);
        actions[action.id] = action;
        const owner = resolveFormOwner(observation, relations, [control]);
        if (owner.status === 'ambiguous' || owner.status === 'invalid') {
            diagnostics.push(formOwnerDiagnostic([control], owner.candidateNodeIds, owner.status));
        }
        if (owner.status === 'resolved') {
            const bucket = forcedActionIdsByBoundary.get(owner.ownerNodeId) ?? [];
            bucket.push(action.id);
            forcedActionIdsByBoundary.set(owner.ownerNodeId, bucket);
        } else {
            const bucket = actionIdsByNode.get(action.nodeId) ?? [];
            bucket.push(action.id);
            actionIdsByNode.set(action.nodeId, bucket);
        }
    }

    const boundaryKinds = new Map<ObservationNodeId, FormBoundaryKind>();
    for (const nodeId of orderedNodeIds(observation)) {
        const kind = explicitBoundaryKind(observation, nodeId);
        if (kind) {boundaryKinds.set(nodeId, kind);}
    }

    const roots = reduceBottomUp<FormReductionState>(observation, (nodeId, childStates) => {
        const state = mergeReductionStates(childStates);
        state.unclaimedFieldIds.push(...(fieldIdsByAnchor.get(nodeId) ?? []));
        state.unclaimedFieldIds.push(...(forcedFieldIdsByBoundary.get(nodeId) ?? []));
        state.localActionIds.push(...(actionIdsByNode.get(nodeId) ?? []));
        state.localActionIds.push(...(forcedActionIdsByBoundary.get(nodeId) ?? []));

        const explicitKind = boundaryKinds.get(nodeId);
        const localIsland = !explicitKind && shouldReduceLocalIsland(
            observation,
            nodeId,
            state,
            fields,
            actions,
            boundaryKinds,
            standaloneFieldIds,
        );
        const boundaryKind = explicitKind ?? (localIsland ? 'local-island' : undefined);
        if (!boundaryKind) {return state;}
        if (state.unclaimedFieldIds.length === 0) {
            reductionTrace.push({ nodeId, outcome: 'skipped', reason: 'boundary-without-fields', fieldIds: [], actionIds: unique(state.localActionIds) });
            return state;
        }
        const consumedFieldIds = boundaryKind === 'local-island'
            ? unique(state.unclaimedFieldIds).filter((fieldId) => !standaloneFieldIds.has(fieldId))
            : unique(state.unclaimedFieldIds);
        const proposal: FormProposal = {
            rootNodeId: nodeId,
            boundaryKind,
            fieldIds: consumedFieldIds,
            actionIds: unique(state.localActionIds),
            evidence: boundaryEvidence(input.observation, nodeId, boundaryKind),
        };
        const form = completeForm(input, proposal, fields, actions, groups);
        forms[form.id] = form;
        diagnostics.push(...form.diagnostics);
        state.completedFormIds.push(form.id);
        reductionTrace.push({ nodeId, outcome: 'formed', reason: `consumed-by-${boundaryKind}`, fieldIds: consumedFieldIds, actionIds: proposal.actionIds, formId: form.id });
        const consumedSet = new Set(consumedFieldIds);
        state.unclaimedFieldIds = state.unclaimedFieldIds.filter((fieldId) => !consumedSet.has(fieldId));
        state.localActionIds = [];
        return state;
    }, emptyReductionState);

    const residualFieldIds = unique(roots.flatMap((state) => state.unclaimedFieldIds));
    const residualActionIds = unique(roots.flatMap((state) => state.localActionIds));
    for (const fieldId of residualFieldIds) {
        const field = fields[fieldId];
        if (!field) {continue;}
        reductionTrace.push({
            nodeId: field.anchorNodeId,
            outcome: 'residual',
            reason: standaloneFieldIds.has(fieldId) ? 'utility-or-table-standalone' : 'no-valid-form-boundary',
            fieldIds: [fieldId],
            actionIds: [],
        });
    }
    for (const state of roots) {
        const actionIds = unique(state.localActionIds);
        if (actionIds.length === 0) {continue;}
        const firstAction = actions[actionIds[0]];
        reductionTrace.push({
            nodeId: firstAction?.nodeId ?? observation.scopes.scopes[observation.scopes.rootScopeIds[0]]?.rootNodeId ?? '',
            outcome: 'residual',
            reason: 'actions-without-form-boundary',
            fieldIds: [],
            actionIds,
        });
    }
    const ownershipEdges = buildFormOwnership(forms, fields, groups, actions);
    const ownership = buildOwnershipIndex(ownershipEdges);
    diagnostics.push(...ownership.diagnostics);
    const byNodeId = buildFormNodeIndex(forms, fields, groups, actions);
    const provisional: FormComponentIndex = {
        forms,
        fields,
        groups,
        actions,
        residualFieldIds,
        residualActionIds,
        ownership,
        byNodeId,
        reductionTrace,
        diagnostics,
        validation: { ok: true, diagnostics: [] },
    };
    const validation = validateFormComponentIndex(provisional, observation, controls);
    diagnostics.push(...validation.diagnostics);
    return deepFreeze({ ...provisional, diagnostics, validation });
};

export const validateFormComponentIndex = (
    index: FormComponentIndex,
    observation: PageObservation,
    controls: ControlIndex,
): FormInvariantValidation => {
    const diagnostics: AnalysisDiagnostic[] = [];
    const add = (code: string, message: string, nodeIds: ObservationNodeId[] = []) => {
        diagnostics.push({
            code,
            severity: 'error',
            stage: code.startsWith('ownership.') ? 'ownership' : 'form',
            status: 'ambiguous',
            nodeIds: unique(nodeIds),
            evidence: [],
            message,
        });
    };

    for (const field of Object.values(index.fields)) {
        if (field.controlIds.length === 0) {
            add('form.field.control-empty', `form field has no controls: ${field.id}`, field.memberNodeIds);
        }
        for (const controlId of field.controlIds) {
            const control = controls.controls[controlId];
            if (!control) {
                add('form.field.control-missing', `form field references missing control: ${controlId}`, field.memberNodeIds);
                continue;
            }
            if (control.kind === 'popup' || control.kind === 'option') {
                add('form.field.popup-control', `popup/option cannot be a form field control: ${controlId}`, control.memberNodeIds);
            }
        }
        if (field.primaryControlId && !field.controlIds.includes(field.primaryControlId)) {
            add('form.field.primary-outside', `primary control is not a field member: ${field.id}`, field.memberNodeIds);
        }
        if (!observation.nodes[field.anchorNodeId]) {
            add('form.field.anchor-missing', `form field anchor is missing: ${field.anchorNodeId}`);
        }
    }

    for (const actionId of index.residualActionIds) {
        if (!index.actions[actionId]) {
            add('form.action.residual-missing', `residual action is missing from action index: ${actionId}`);
        }
    }

    for (const form of Object.values(index.forms)) {
        if (!observation.nodes[form.location.structuralRootNodeId]) {
            add('form.root.missing', `form structural root is missing: ${form.location.structuralRootNodeId}`);
        }
        if (form.fields.length === 0) {
            add('form.fields.empty', `form has no fields: ${form.id}`, [form.location.structuralRootNodeId]);
        }
        for (const field of form.fields) {
            if (!index.fields[field.id]) {
                add('form.field.index-missing', `form references an unknown field: ${field.id}`, [form.location.structuralRootNodeId]);
            }
        }
    }

    const ownershipValidation = validateOwnershipIndex(index.ownership.edges);
    diagnostics.push(...ownershipValidation.diagnostics);
    for (const edge of index.ownership.edges) {
        if (!ownershipEndpointExists(edge.owner, index, controls, observation)) {
            add('ownership.endpoint.owner-missing', `ownership owner endpoint is missing: ${ownershipEndpointKey(edge.owner)}`);
        }
        if (!ownershipEndpointExists(edge.member, index, controls, observation)) {
            add('ownership.endpoint.member-missing', `ownership member endpoint is missing: ${ownershipEndpointKey(edge.member)}`);
        }
    }

    return deepFreeze({ ok: diagnostics.length === 0, diagnostics });
};

const buildField = (
    observation: PageObservation,
    relations: RelationIndex,
    controls: ControlIndex,
    anchorNodeId: ObservationNodeId,
    members: ControlComponent[],
    groups: Record<string, FormGroup>,
): FormField => {
    const relationNodeIds = unique(members.flatMap((control) => control.memberNodeIds));
    const labelEvidence = collectLabelEvidence(observation, relations, anchorNodeId, relationNodeIds);
    const descriptionNodeIds = relationTargets(relations, relationNodeIds, 'described-by');
    const errorNodeIds = unique([
        ...relationTargets(relations, relationNodeIds, 'error-message'),
        ...descendants(observation, anchorNodeId).filter((nodeId) => isErrorNode(observation, nodeId)),
    ]);
    const status = aggregateStatus(members.map((control) => control.status));
    const primaryControlId = members.find((control) =>
        control.capabilities.includes('fill') || control.capabilities.includes('select_option'))?.id
        ?? members[0]?.id;
    const evidence = uniqueEvidence([
        ...labelEvidence.evidence,
        fieldAdapterEvidence(observation, anchorNodeId, members),
        {
            code: 'form.field.control-members',
            strength: 'exact',
            source: 'platform',
            nodeIds: relationNodeIds,
            detail: { controlIds: members.map((control) => control.id) },
        },
    ].filter((item): item is Evidence => Boolean(item)));
    const diagnostics: AnalysisDiagnostic[] = members.flatMap((control) => control.diagnostics);
    const group = buildFieldGroup(observation, anchorNodeId, labelEvidence.labelNodeIds, groups);
    const field: FormField = {
        id: `form-field:${anchorNodeId}`,
        status,
        anchorNodeId,
        controlIds: members.map((control) => control.id),
        primaryControlId,
        labelNodeIds: labelEvidence.labelNodeIds,
        descriptionNodeIds,
        errorNodeIds,
        memberNodeIds: unique([
            anchorNodeId,
            ...relationNodeIds,
            ...labelEvidence.labelNodeIds,
            ...descriptionNodeIds,
            ...errorNodeIds,
        ]),
        groupId: group?.id,
        required: members.some((control) => isControlRequired(observation, control))
            || isRequiredContainer(observation, anchorNodeId),
        evidence,
        diagnostics,
    };
    if (group) {
        group.fieldIds.push(field.id);
        groups[group.id] = group;
    }
    return field;
};

const buildFieldGroup = (
    observation: PageObservation,
    anchorNodeId: ObservationNodeId,
    labelNodeIds: ObservationNodeId[],
    groups: Record<string, FormGroup>,
): FormGroup | undefined => {
    const fieldsetId = nearestAncestorOrSelf(observation, anchorNodeId, (nodeId) =>
        observation.nodes[nodeId]?.tag === 'fieldset');
    if (!fieldsetId) {return undefined;}
    const id = `form-group:${fieldsetId}`;
    const existing = groups[id];
    if (existing) {return existing;}
    const legendIds = (observation.children[fieldsetId] ?? [])
        .filter((nodeId) => observation.nodes[nodeId]?.tag === 'legend');
    return {
        id,
        rootNodeId: fieldsetId,
        labelNodeIds: unique(legendIds),
        fieldIds: [],
        evidence: [{
            code: 'form.group.fieldset',
            strength: 'exact',
            source: 'platform',
            nodeIds: [fieldsetId, ...legendIds],
        }],
    };
};

const buildAction = (observation: PageObservation, control: ControlComponent): FormAction => {
    const nodeId = control.controlNodeId ?? control.rootNodeId;
    const node = observation.nodes[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    const type = lower(attrs.type);
    const structuralRole: FormAction['structuralRole'] = control.kind === 'link'
        ? 'link'
        : type === 'reset'
            ? 'reset'
            : type === 'submit' || type === 'image' || (node?.tag === 'button' && !type)
                ? 'submit'
                : 'button';
    const actionText = nodeText(observation, nodeId);
    const suggestion = inferActionSuggestion(actionText, nodeId);
    return {
        id: `form-action:${control.id}`,
        controlId: control.id,
        nodeId,
        structuralRole,
        suggestions: suggestion ? [suggestion] : [],
        evidence: [{
            code: 'form.action.structural-role',
            strength: 'exact',
            source: 'dom',
            nodeIds: [nodeId],
            detail: { structuralRole },
        }],
    };
};

const completeForm = (
    input: BuildFormSnapshotInput,
    proposal: FormProposal,
    fields: Record<string, FormField>,
    actions: Record<string, FormAction>,
    groups: Record<string, FormGroup>,
): FormComponent => {
    const { rootNodeId, boundaryKind, fieldIds, actionIds } = proposal;
    const formFields = fieldIds.map((fieldId) => fields[fieldId]).filter(Boolean)
        .sort((left, right) => compareNodeOrder(input.observation, left.anchorNodeId, right.anchorNodeId));
    const formActions = actionIds.map((actionId) => actions[actionId]).filter(Boolean)
        .sort((left, right) => compareNodeOrder(input.observation, left.nodeId, right.nodeId));
    const groupIds = unique(formFields.map((field) => field.groupId).filter((value): value is string => Boolean(value)));
    const formGroups = groupIds.map((groupId) => groups[groupId]).filter(Boolean);
    const hostNodeId = boundaryKind === 'dialog'
        ? rootNodeId
        : nearestAncestor(input.observation, rootNodeId, (nodeId) => isActiveDialog(input.observation, nodeId));
    const selectionScopeNodeId = input.selectionScopeNodeId
        && isDescendantOrSelf(input.observation, rootNodeId, input.selectionScopeNodeId)
        ? input.selectionScopeNodeId
        : undefined;
    const evidence = proposal.evidence;
    return {
        id: `form:${rootNodeId}`,
        status: aggregateStatus(formFields.map((field) => field.status)),
        boundaryKind,
        location: {
            selectionScopeNodeId,
            hostNodeId,
            structuralRootNodeId: rootNodeId,
        },
        fields: formFields,
        actions: formActions,
        groups: formGroups,
        geometry: unique([rootNodeId, ...formFields.map((field) => field.anchorNodeId)])
            .map((nodeId) => ({ nodeId, records: input.observation.geometry[nodeId] ?? [] }))
            .filter((fragment) => fragment.records.length > 0),
        suggestions: inferFormSuggestions(boundaryKind, hostNodeId, formActions, rootNodeId),
        evidence,
        diagnostics: uniqueDiagnostics(formFields.flatMap((field) => field.diagnostics)),
    };
};

const buildFormOwnership = (
    forms: Readonly<Record<string, FormComponent>>,
    fields: Readonly<Record<string, FormField>>,
    groups: Readonly<Record<string, FormGroup>>,
    actions: Readonly<Record<string, FormAction>>,
): OwnershipEdge[] => {
    const edges: OwnershipEdge[] = [];
    for (const field of Object.values(fields)) {
        for (const controlId of field.controlIds) {
            edges.push({
                owner: { kind: 'form-field', id: field.id },
                member: { kind: 'control', id: controlId },
                role: 'control',
                evidence: field.evidence,
            });
        }
        if (field.groupId) {
            edges.push({
                owner: { kind: 'form-group', id: field.groupId },
                member: { kind: 'form-field', id: field.id },
                role: 'field',
                evidence: groups[field.groupId]?.evidence ?? field.evidence,
            });
        }
    }
    for (const form of Object.values(forms)) {
        for (const field of form.fields) {
            edges.push({
                owner: { kind: 'form', id: form.id },
                member: { kind: 'form-field', id: field.id },
                role: 'field',
                evidence: form.evidence,
            });
        }
        for (const action of form.actions) {
            edges.push({
                owner: { kind: 'form', id: form.id },
                member: { kind: 'form-action', id: action.id },
                role: 'action',
                evidence: action.evidence,
            });
        }
        for (const group of form.groups) {
            edges.push({
                owner: { kind: 'form', id: form.id },
                member: { kind: 'form-group', id: group.id },
                role: 'group',
                evidence: group.evidence,
            });
        }
    }
    return edges;
};

const buildFormNodeIndex = (
    forms: Readonly<Record<string, FormComponent>>,
    fields: Readonly<Record<string, FormField>>,
    groups: Readonly<Record<string, FormGroup>>,
    actions: Readonly<Record<string, FormAction>>,
): Record<ObservationNodeId, string[]> => {
    const result: Record<ObservationNodeId, string[]> = {};
    const add = (nodeId: ObservationNodeId, id: string) => (result[nodeId] ??= []).push(id);
    for (const form of Object.values(forms)) {
        add(form.location.structuralRootNodeId, form.id);
        if (form.location.hostNodeId) {add(form.location.hostNodeId, form.id);}
        if (form.location.selectionScopeNodeId) {add(form.location.selectionScopeNodeId, form.id);}
    }
    for (const field of Object.values(fields)) {
        for (const nodeId of field.memberNodeIds) {add(nodeId, field.id);}
    }
    for (const group of Object.values(groups)) {
        add(group.rootNodeId, group.id);
        for (const nodeId of group.labelNodeIds) {add(nodeId, group.id);}
    }
    for (const action of Object.values(actions)) {add(action.nodeId, action.id);}
    return result;
};

const findFieldAnchor = (
    observation: PageObservation,
    control: ControlComponent,
    allFieldControls: readonly ControlComponent[],
): ObservationNodeId => {
    const startNodeId = control.rootNodeId;
    const adapterItem = nearestAncestorOrSelf(observation, startNodeId, (nodeId) => isAdapterFormItem(observation, nodeId));
    if (adapterItem) {return adapterItem;}
    const fieldset = nearestAncestorOrSelf(observation, startNodeId, (nodeId) => observation.nodes[nodeId]?.tag === 'fieldset');
    if (fieldset && !hasIndividualFieldEvidence(observation, fieldset)) {return fieldset;}
    const wrappingLabel = nearestAncestorOrSelf(observation, startNodeId, (nodeId) => observation.nodes[nodeId]?.tag === 'label');
    if (wrappingLabel) {return wrappingLabel;}
    if (control.kind === 'radio_group' || control.kind === 'checkbox_group') {return control.rootNodeId;}
    const parentNodeId = observation.parents[startNodeId];
    if (parentNodeId && isSafeCompositeContainer(observation, parentNodeId)) {
        const controlsInContainer = allFieldControls.filter((candidate) =>
            isDescendantOrSelf(observation, candidate.rootNodeId, parentNodeId));
        if (controlsInContainer.length > 1) {return parentNodeId;}
    }
    return startNodeId;
};

const collectLabelEvidence = (
    observation: PageObservation,
    relations: RelationIndex,
    anchorNodeId: ObservationNodeId,
    controlNodeIds: readonly ObservationNodeId[],
): { labelNodeIds: ObservationNodeId[]; evidence: Evidence[] } => {
    const exactLabelFor = relationSources(relations, controlNodeIds, 'label-for');
    const labelledBy = relationTargets(relations, controlNodeIds, 'labelled-by');
    const fieldsetId = nearestAncestorOrSelf(observation, anchorNodeId, (nodeId) => observation.nodes[nodeId]?.tag === 'fieldset');
    const legendIds = fieldsetId
        ? (observation.children[fieldsetId] ?? []).filter((nodeId) => observation.nodes[nodeId]?.tag === 'legend')
        : [];
    const adapterLabels = isAdapterFormItem(observation, anchorNodeId)
        ? descendants(observation, anchorNodeId).filter((nodeId) => observation.nodes[nodeId]?.tag === 'label')
        : [];
    const wrappedLabel = nearestAncestorOrSelf(observation, anchorNodeId, (nodeId) => observation.nodes[nodeId]?.tag === 'label');
    const explicitLabelNodeIds = unique([
        ...exactLabelFor,
        ...labelledBy,
        ...adapterLabels,
        ...(wrappedLabel ? [wrappedLabel] : []),
    ]);
    const labelNodeIds = explicitLabelNodeIds.length > 0 ? explicitLabelNodeIds : unique(legendIds);
    const evidence: Evidence[] = [];
    if (exactLabelFor.length > 0) evidence.push({ code: 'form.field.label-for', strength: 'exact', source: 'dom', nodeIds: [...exactLabelFor, ...controlNodeIds] });
    if (labelledBy.length > 0) evidence.push({ code: 'form.field.aria-labelledby', strength: 'exact', source: 'dom', nodeIds: [...controlNodeIds, ...labelledBy] });
    if (explicitLabelNodeIds.length === 0 && legendIds.length > 0) evidence.push({ code: 'form.field.fieldset-legend', strength: 'strong', source: 'platform', nodeIds: [fieldsetId!, ...legendIds] });
    if (adapterLabels.length > 0) evidence.push({ code: 'form.field.adapter-label', strength: 'strong', source: 'adapter', nodeIds: [anchorNodeId, ...adapterLabels] });
    if (wrappedLabel) evidence.push({ code: 'form.field.wrapped-label', strength: 'strong', source: 'platform', nodeIds: [wrappedLabel, ...controlNodeIds] });
    return { labelNodeIds, evidence };
};

const fieldAdapterEvidence = (
    observation: PageObservation,
    anchorNodeId: ObservationNodeId,
    controls: readonly ControlComponent[],
): Evidence | undefined => {
    const tokens = classTokens(observation.attributes[anchorNodeId]?.class);
    if (tokens.includes(ELEMENT_FORM_ITEM)) {
        return { code: 'form.field.adapter.element-form-item', strength: 'strong', source: 'adapter', nodeIds: [anchorNodeId, ...controls.flatMap((control) => control.memberNodeIds)] };
    }
    if (tokens.includes(ANT_FORM_ITEM)) {
        return { code: 'form.field.adapter.ant-form-item', strength: 'strong', source: 'adapter', nodeIds: [anchorNodeId, ...controls.flatMap((control) => control.memberNodeIds)] };
    }
    return undefined;
};

const explicitBoundaryKind = (observation: PageObservation, nodeId: ObservationNodeId): FormBoundaryKind | undefined => {
    const node = observation.nodes[nodeId];
    if (!node) {return undefined;}
    if (node.tag === 'form') {return 'explicit-form';}
    if (isActiveDialog(observation, nodeId)) {return 'dialog';}
    const role = resolveSemanticRole(observation, nodeId).value;
    const tokens = classTokens(observation.attributes[nodeId]?.class);
    if (role === 'form' || tokens.includes('el-form') || tokens.includes('ant-form')) {return 'adapter-form';}
    return undefined;
};

const shouldReduceLocalIsland = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    state: FormReductionState,
    fields: Readonly<Record<string, FormField>>,
    actions: Readonly<Record<string, FormAction>>,
    boundaries: ReadonlyMap<ObservationNodeId, FormBoundaryKind>,
    standaloneFieldIds: ReadonlySet<string>,
): boolean => {
    const node = observation.nodes[nodeId];
    if (!node || node.tag === 'html' || node.tag === 'body' || node.tag === '#shadow-root') {return false;}
    if (hasBoundaryAncestor(observation, nodeId, boundaries)) {return false;}
    if (isUtilityContainer(observation, nodeId) || isTableContainer(observation, nodeId)) {return false;}
    const localFields = unique(state.unclaimedFieldIds)
        .filter((fieldId) => !standaloneFieldIds.has(fieldId))
        .map((fieldId) => fields[fieldId])
        .filter(Boolean);
    const localActions = unique(state.localActionIds).map((actionId) => actions[actionId]).filter(Boolean);
    if (localFields.length < 2 || localActions.length < 1) {return false;}
    if (localActions.length > localFields.length * 2) {return false;}
    return localFields.every((field) => field.labelNodeIds.length > 0 || hasAccessibleName(observation, field));
};

type FormOwnerResolution =
    | { status: 'none' }
    | { status: 'resolved'; ownerNodeId: ObservationNodeId }
    | { status: 'ambiguous' | 'invalid'; candidateNodeIds: ObservationNodeId[] };

const resolveFormOwner = (
    observation: PageObservation,
    relations: RelationIndex,
    controls: readonly ControlComponent[],
): FormOwnerResolution => {
    const edges = controls.flatMap((control) => control.memberNodeIds.flatMap((nodeId) =>
        (relations.bySourceNodeId[nodeId] ?? []).map((edgeIndex) => relations.edges[edgeIndex]).filter(Boolean)))
        .filter((edge) => edge.kind === 'form-owner');
    if (edges.length === 0) {return { status: 'none' };}
    const targets = unique(edges.flatMap((edge) => edge.targetNodeIds));
    const forms = targets.filter((nodeId) => observation.nodes[nodeId]?.tag === 'form');
    if (edges.some((edge) => edge.status === 'ambiguous') || forms.length > 1) {
        return { status: 'ambiguous', candidateNodeIds: targets };
    }
    if (edges.some((edge) => edge.status === 'unresolved') || targets.length !== 1 || forms.length !== 1) {
        return { status: 'invalid', candidateNodeIds: targets };
    }
    return { status: 'resolved', ownerNodeId: forms[0] };
};

const formOwnerDiagnostic = (
    controls: readonly ControlComponent[],
    candidateNodeIds: readonly ObservationNodeId[],
    status: 'ambiguous' | 'invalid',
): AnalysisDiagnostic => ({
    code: status === 'ambiguous' ? 'form.owner.ambiguous' : 'form.owner.unresolved',
    severity: 'error',
    stage: 'form',
    status: status === 'ambiguous' ? 'ambiguous' : 'rejected',
    nodeIds: unique([...controls.flatMap((control) => control.memberNodeIds), ...candidateNodeIds]),
    evidence: controls.flatMap((control) => control.evidence),
    message: status === 'ambiguous'
        ? 'form attribute resolves to multiple form owners'
        : 'form attribute does not resolve to a form owner',
});

const relationTargets = (
    relations: RelationIndex,
    sourceNodeIds: readonly ObservationNodeId[],
    kind: RelationEdge['kind'],
): ObservationNodeId[] => unique(sourceNodeIds.flatMap((sourceNodeId) =>
    (relations.bySourceNodeId[sourceNodeId] ?? [])
        .map((edgeIndex) => relations.edges[edgeIndex])
        .filter((edge) => edge?.kind === kind && edge.status === 'resolved')
        .flatMap((edge) => edge.targetNodeIds)));

const relationSources = (
    relations: RelationIndex,
    targetNodeIds: readonly ObservationNodeId[],
    kind: RelationEdge['kind'],
): ObservationNodeId[] => unique(targetNodeIds.flatMap((targetNodeId) =>
    (relations.byTargetNodeId[targetNodeId] ?? [])
        .map((edgeIndex) => relations.edges[edgeIndex])
        .filter((edge) => edge?.kind === kind && edge.status === 'resolved')
        .map((edge) => edge.sourceNodeId)));

const boundaryEvidence = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    kind: FormBoundaryKind,
): Evidence[] => {
    const tokens = classTokens(observation.attributes[nodeId]?.class);
    if (tokens.includes('el-form')) return [{ code: 'form.boundary.adapter.element-form', strength: 'strong', source: 'adapter', nodeIds: [nodeId] }];
    if (tokens.includes('ant-form')) return [{ code: 'form.boundary.adapter.ant-form', strength: 'strong', source: 'adapter', nodeIds: [nodeId] }];
    return [{
        code: kind === 'explicit-form'
            ? 'form.boundary.native-form'
            : kind === 'dialog'
                ? 'form.boundary.active-dialog'
                : kind === 'local-island'
                    ? 'form.boundary.local-island'
                    : 'form.boundary.role-form',
        strength: kind === 'local-island' ? 'strong' : 'exact',
        source: kind === 'local-island' ? 'platform' : 'dom',
        nodeIds: [nodeId],
    }];
};

const isControlRequired = (observation: PageObservation, control: ControlComponent): boolean =>
    control.memberNodeIds.some((nodeId) => {
        const attrs = observation.attributes[nodeId] ?? {};
        return hasBooleanAttribute(attrs, 'required') || lower(attrs['aria-required']) === 'true';
    });

const isRequiredContainer = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const attrs = observation.attributes[nodeId] ?? {};
    const tokens = classTokens(attrs.class);
    return hasBooleanAttribute(attrs, 'required')
        || lower(attrs['aria-required']) === 'true'
        || tokens.includes('is-required')
        || tokens.includes('ant-form-item-required');
};

const isErrorNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const role = resolveSemanticRole(observation, nodeId).value;
    const tokens = classTokens(observation.attributes[nodeId]?.class);
    return role === 'alert'
        || tokens.includes('el-form-item__error')
        || tokens.includes('ant-form-item-explain-error');
};

const inferFormSuggestions = (
    boundaryKind: FormBoundaryKind,
    hostNodeId: ObservationNodeId | undefined,
    actions: readonly FormAction[],
    rootNodeId: ObservationNodeId,
): FormComponent['suggestions'] => {
    const values: string[] = [];
    if (boundaryKind === 'dialog' || hostNodeId) {values.push('dialog-form');}
    if (actions.some((action) => action.suggestions.some((suggestion) => suggestion.value === 'search'))) {
        values.push('filter-form');
    } else if (actions.some((action) => action.structuralRole === 'submit')) {
        values.push('data-entry-form');
    }
    return unique(values).map((value) => ({
        kind: 'component-kind',
        value,
        source: 'inferred',
        evidence: [{
            code: 'form.component-kind.suggestion',
            strength: 'weak',
            source: 'platform',
            nodeIds: [rootNodeId],
            detail: { value },
        }],
    }));
};

const inferActionSuggestion = (
    text: string,
    nodeId: ObservationNodeId,
): FormAction['suggestions'][number] | undefined => {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim();
    const values: Array<[RegExp, string]> = [
        [/(^|\s)(cancel|close)(\s|$)|取消|关闭/, 'cancel'],
        [/save\s*draft|暂存|存草稿/, 'save-draft'],
        [/search|filter|查询|搜索|筛选/, 'search'],
        [/save|submit|保存|提交/, 'save'],
    ];
    const matched = values.find(([pattern]) => pattern.test(normalized));
    if (!matched) {return undefined;}
    return {
        kind: 'action-intent',
        value: matched[1],
        source: 'inferred',
        evidence: [{
            code: 'form.action.text-suggestion',
            strength: 'weak',
            source: 'dom',
            nodeIds: [nodeId],
            detail: { text },
        }],
    };
};

const nodeText = (observation: PageObservation, nodeId: ObservationNodeId): string =>
    observation.accessibility[nodeId]?.name
    ?? observation.text[nodeId]
    ?? observation.attributes[nodeId]?.['aria-label']
    ?? observation.attributes[nodeId]?.title
    ?? '';

const hasAccessibleName = (observation: PageObservation, field: FormField): boolean =>
    field.controlIds.some(() => field.memberNodeIds.some((nodeId) => Boolean(
        observation.accessibility[nodeId]?.name
        || observation.attributes[nodeId]?.['aria-label']
        || observation.attributes[nodeId]?.placeholder,
    )));

const hasIndividualFieldEvidence = (
    observation: PageObservation,
    fieldsetNodeId: ObservationNodeId,
): boolean => descendants(observation, fieldsetNodeId).some((nodeId) => {
    const node = observation.nodes[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    if (node?.tag === 'label') {
        return Boolean(attrs.for)
            || descendants(observation, nodeId).some((childId) => FORM_CONTROL_TAGS.has(observation.nodes[childId]?.tag ?? ''));
    }
    return FORM_CONTROL_TAGS.has(node?.tag ?? '')
        && Boolean(attrs['aria-label'] || attrs['aria-labelledby']);
});

const isAdapterFormItem = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const tokens = classTokens(observation.attributes[nodeId]?.class);
    return tokens.includes(ELEMENT_FORM_ITEM) || tokens.includes(ANT_FORM_ITEM);
};

const isSafeCompositeContainer = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const tag = observation.nodes[nodeId]?.tag;
    if (!tag || tag === 'form' || tag === 'body' || tag === 'html') {return false;}
    if (isUtilityContainer(observation, nodeId) || isTableContainer(observation, nodeId)) {return false;}
    const tokens = classTokens(observation.attributes[nodeId]?.class);
    return tokens.some((token) => COMPOSITE_CLASS_PATTERN.test(token));
};

const isUtilityContainer = (observation: PageObservation, nodeId: ObservationNodeId): boolean =>
    ancestorIds(observation, nodeId).some((ancestorId) =>
        classTokens(observation.attributes[ancestorId]?.class)
            .some((token) => UTILITY_CLASSES.has(token.toLowerCase())));

const isTableContainer = (observation: PageObservation, nodeId: ObservationNodeId): boolean =>
    ancestorIds(observation, nodeId).some((ancestorId) => {
        const node = observation.nodes[ancestorId];
        const role = resolveSemanticRole(observation, ancestorId).value;
        const tokens = classTokens(observation.attributes[ancestorId]?.class);
        return node?.tag === 'table'
            || role === 'table'
            || role === 'grid'
            || tokens.includes('el-table')
            || tokens.includes('ant-table-wrapper');
    });

const isActiveDialog = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const role = resolveSemanticRole(observation, nodeId).value;
    const activity = observation.activity[nodeId];
    return (role === 'dialog' || role === 'alertdialog')
        && Boolean(activity?.rendered)
        && !activity?.hiddenByStyle
        && !activity?.inert
        && activity?.ariaExposed !== false;
};

const hasBoundaryAncestor = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    boundaries: ReadonlyMap<ObservationNodeId, FormBoundaryKind>,
): boolean => ancestorIds(observation, nodeId).slice(1).some((ancestorId) => boundaries.has(ancestorId));

const ownershipEndpointExists = (
    endpoint: OwnershipEndpoint,
    index: FormComponentIndex,
    controls: ControlIndex,
    observation: PageObservation,
): boolean => {
    switch (endpoint.kind) {
        case 'node': return Boolean(observation.nodes[endpoint.id]);
        case 'control': return Boolean(controls.controls[endpoint.id]);
        case 'form-field': return Boolean(index.fields[endpoint.id]);
        case 'form-group': return Boolean(index.groups[endpoint.id]);
        case 'form-action': return Boolean(index.actions[endpoint.id]);
        case 'form': return Boolean(index.forms[endpoint.id]);
        default: return true;
    }
};

const aggregateStatus = (statuses: readonly AssemblyStatus[]): AssemblyStatus => {
    if (statuses.includes('ambiguous')) {return 'ambiguous';}
    if (statuses.includes('rejected')) {return 'rejected';}
    if (statuses.includes('partial')) {return 'partial';}
    return 'complete';
};

const emptyReductionState = (): FormReductionState => ({
    unclaimedFieldIds: [],
    localActionIds: [],
    completedFormIds: [],
    diagnostics: [],
});

const mergeReductionStates = (states: readonly FormReductionState[]): FormReductionState => ({
    unclaimedFieldIds: states.flatMap((state) => state.unclaimedFieldIds),
    localActionIds: states.flatMap((state) => state.localActionIds),
    completedFormIds: states.flatMap((state) => state.completedFormIds),
    diagnostics: states.flatMap((state) => state.diagnostics),
});

const descendants = (observation: PageObservation, rootNodeId: ObservationNodeId): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    const stack = [...(observation.children[rootNodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const nodeId = stack.pop();
        if (!nodeId) {continue;}
        output.push(nodeId);
        const children = observation.children[nodeId] ?? [];
        for (let index = children.length - 1; index >= 0; index -= 1) {stack.push(children[index]);}
    }
    return output;
};

const ancestorIds = (observation: PageObservation, nodeId: ObservationNodeId): ObservationNodeId[] => {
    const output: ObservationNodeId[] = [];
    let cursor: ObservationNodeId | undefined = nodeId;
    const visited = new Set<ObservationNodeId>();
    while (cursor && !visited.has(cursor)) {
        output.push(cursor);
        visited.add(cursor);
        cursor = observation.parents[cursor];
    }
    return output;
};

const nearestAncestorOrSelf = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    predicate: (candidateNodeId: ObservationNodeId) => boolean,
): ObservationNodeId | undefined => ancestorIds(observation, nodeId).find(predicate);

const nearestAncestor = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    predicate: (candidateNodeId: ObservationNodeId) => boolean,
): ObservationNodeId | undefined => ancestorIds(observation, nodeId).slice(1).find(predicate);

const isDescendantOrSelf = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    ancestorNodeId: ObservationNodeId,
): boolean => ancestorIds(observation, nodeId).includes(ancestorNodeId);

const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((left, right) => compareNodeOrder(observation, left, right));

const compareNodeOrder = (observation: PageObservation, left: ObservationNodeId, right: ObservationNodeId): number =>
    (observation.documentOrder[left] ?? Number.MAX_SAFE_INTEGER)
    - (observation.documentOrder[right] ?? Number.MAX_SAFE_INTEGER);

const hasBooleanAttribute = (attributes: Readonly<Record<string, string>>, name: string): boolean =>
    Object.prototype.hasOwnProperty.call(attributes, name)
    && !['false', '0'].includes(lower(attributes[name]));

const classTokens = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter(Boolean);
const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const uniqueEvidence = (values: readonly Evidence[]): Evidence[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = `${value.code}|${value.nodeIds.join(',')}`;
        if (seen.has(key)) {return false;}
        seen.add(key);
        return true;
    });
};
const uniqueDiagnostics = (values: readonly AnalysisDiagnostic[]): AnalysisDiagnostic[] => {
    const seen = new Set<string>();
    return values.filter((value) => {
        const key = `${value.code}|${value.nodeIds.join(',')}|${value.message}`;
        if (seen.has(key)) {return false;}
        seen.add(key);
        return true;
    });
};
