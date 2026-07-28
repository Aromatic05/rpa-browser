import type {
    AnalysisDiagnostic,
    Evidence,
    ObservationCompleteness,
    ObservationNodeId,
    PageObservation,
} from '../../../observation/model/contracts';
import type {
    RelationEdge,
    RelationIndex,
} from '../../../indexes/relation/contracts';
import { deepFreeze } from '../../../observation/model/freeze';
import { resolveSemanticRole } from '../../../observation/model/semantic';
import type { LocatorIndex } from '../../../indexes/locator/contracts';
import { ControlCollectorRegistry } from './registry';
import type {
    BuildControlSnapshotInput,
    ControlCapability,
    ControlComponent,
    ControlIndex,
    ControlInvariantValidation,
    ControlKind,
    ControlOption,
    ControlRefResolution,
    ControlSnapshot,
    ControlState,
} from '../model/contracts';

export const buildControlSnapshot = (input: BuildControlSnapshotInput): ControlSnapshot => ({
    observation: input.observation,
    relations: input.relations,
    locators: input.locators,
    controls: buildControlIndex(input.observation, input.relations, input.locators, input.registry),
});

export const buildControlIndex = (
    observation: PageObservation,
    relations: RelationIndex,
    locators: LocatorIndex,
    registry: import('../model/contracts').ControlCollectorRegistryPort = createDefaultControlCollectorRegistry(),
): ControlIndex => {
    const controls: Record<string, ControlComponent> = {};
    const byNodeId: Record<ObservationNodeId, string[]> = {};
    const byRef: Record<string, string[]> = {};
    const diagnostics: AnalysisDiagnostic[] = [...locators.diagnostics];
    const consumed = new Set<ObservationNodeId>();

    registry.collect({
        observation,
        relations,
        locators,
        controls,
        consumedNodeIds: consumed,
    });

    for (const component of Object.values(controls)) {
        for (const nodeId of unique([
            component.rootNodeId,
            component.ownerNodeId,
            component.controlNodeId,
            component.triggerNodeId,
            component.popupNodeId,
            ...component.optionNodeIds,
            ...component.memberNodeIds,
        ].filter((value): value is string => Boolean(value)))) {
            (byNodeId[nodeId] ??= []).push(component.id);
        }
        (byRef[component.ref] ??= []).push(component.id);
    }

    for (const [ref, componentIds] of Object.entries(byRef)) {
        if (componentIds.length < 2) {continue;}
        const components = componentIds.map((id) => controls[id]).filter(Boolean);
        const evidence: Evidence = {
            code: 'control.ref.duplicate',
            strength: 'exact',
            source: 'dom',
            nodeIds: unique(components.flatMap((component) => component.memberNodeIds)),
            detail: {
                ref,
                components: components.map((component) => ({
                    id: component.id,
                    kind: component.kind,
                    rootNodeId: component.rootNodeId,
                    ownerNodeId: component.ownerNodeId,
                })),
            },
        };
        const diagnostic = controlDiagnostic(
            'control.ref.duplicate',
            'error',
            'ambiguous',
            evidence.nodeIds,
            [evidence],
            `control ref is not unique: ${ref}`,
        );
        diagnostics.push(diagnostic);
        for (const component of components) {
            component.status = 'ambiguous';
            component.capabilities = [];
            component.diagnostics.push(diagnostic);
            component.evidence.push(evidence);
        }
    }

    const validation = validateControlIndex(controls, byRef, locators);
    diagnostics.push(...validation.diagnostics);
    return deepFreeze({ controls, byNodeId, byRef, diagnostics, validation });
};


export const createDefaultControlCollectorRegistry = (): ControlCollectorRegistry =>
    new ControlCollectorRegistry()
        .register({
            id: 'radio-groups',
            collect: ({ observation, relations, locators, controls, consumedNodeIds }) =>
                collectRadioGroups(observation, relations, locators, controls, consumedNodeIds),
        })
        .register({
            id: 'checkbox-groups',
            collect: ({ observation, relations, locators, controls, consumedNodeIds }) =>
                collectCheckboxGroups(observation, relations, locators, controls, consumedNodeIds),
        })
        .register({
            id: 'custom-selects',
            collect: ({ observation, relations, locators, controls, consumedNodeIds }) =>
                collectCustomSelects(observation, relations, locators, controls, consumedNodeIds),
        })
        .register({
            id: 'native-selects',
            collect: ({ observation, locators, controls, consumedNodeIds }) =>
                collectNativeSelects(observation, locators, controls, consumedNodeIds),
        })
        .register({
            id: 'popup-options',
            collect: ({ observation, locators, controls }) =>
                collectPopupAndOptions(observation, locators, controls),
        })
        .register({
            id: 'atomic-controls',
            collect: ({ observation, locators, controls, consumedNodeIds }) =>
                collectAtomicControls(observation, locators, controls, consumedNodeIds),
        });

export const resolveControlRef = (index: ControlIndex, ref: string): ControlRefResolution => {
    const ids = index.byRef[ref] ?? [];
    const controls = ids.map((id) => index.controls[id]).filter(Boolean);
    const evidence: Evidence = {
        code: controls.length === 1 ? 'control.ref.resolved' : controls.length > 1 ? 'control.ref.ambiguous' : 'control.ref.missing',
        strength: 'exact',
        source: 'dom',
        nodeIds: controls.flatMap((component) => component.memberNodeIds),
        detail: { ref },
    };
    if (controls.length === 0) {return { status: 'missing', evidence: [evidence] };}
    if (controls.length > 1) {return { status: 'ambiguous', candidates: controls, evidence: [evidence] };}
    return { status: 'resolved', value: controls[0], evidence: [evidence] };
};

const collectNativeSelects = (
    observation: PageObservation,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => {
    for (const nodeId of orderedNodeIds(observation)) {
        if (observation.nodes[nodeId]?.tag !== 'select') {continue;}
        const options = descendantIds(observation, nodeId)
            .filter((childId) => observation.nodes[childId]?.tag === 'option')
            .map((childId) => readOption(observation, childId));
        const component = baseComponent(observation, locators, {
            kind: 'native_select',
            rootNodeId: nodeId,
            controlNodeId: nodeId,
            optionNodeIds: options.map((option) => option.nodeId),
            memberNodeIds: [nodeId, ...options.map((option) => option.nodeId)],
            options,
            status: options.length > 0 ? 'complete' : 'partial',
        });
        if (component.status === 'complete' && canExecute(component, locators, observation)) {
            component.capabilities.push('focus', 'click', 'select_option');
        }
        add(controls, component);
        consumed.add(nodeId);
        for (const option of options) {consumed.add(option.nodeId);}
    }
};

const collectRadioGroups = (
    observation: PageObservation,
    relations: RelationIndex,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => collectChoiceGroups('radio_group', 'radio', observation, relations, locators, controls, consumed);

const collectCheckboxGroups = (
    observation: PageObservation,
    relations: RelationIndex,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => collectChoiceGroups('checkbox_group', 'checkbox', observation, relations, locators, controls, consumed);

const collectChoiceGroups = (
    kind: 'radio_group' | 'checkbox_group',
    inputType: 'radio' | 'checkbox',
    observation: PageObservation,
    relations: RelationIndex,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => {
    const groups = new Map<string, ObservationNodeId[]>();
    for (const nodeId of orderedNodeIds(observation)) {
        if (observation.nodes[nodeId]?.tag !== 'input') {continue;}
        if (lower(observation.attributes[nodeId]?.type) !== inputType) {continue;}
        const name = observation.attributes[nodeId]?.name?.trim() ?? '';
        if (kind === 'radio_group' && !name) {continue;}
        const boundary = findSafeBoundary(observation, nodeId, kind);
        if (kind === 'checkbox_group' && !boundary) {continue;}
        const owner = resolveNativeFormOwner(observation, relations, nodeId);
        const key = `${boundary ?? observation.nodes[nodeId]?.scopeId ?? ''}\u0000${owner}\u0000${kind === 'radio_group' ? name : ''}`;
        (groups.get(key) ?? groups.set(key, []).get(key)!).push(nodeId);
    }
    for (const members of groups.values()) {
        if (members.length < 2) {continue;}
        const rootNodeId = findSafeBoundary(observation, members[0], kind) ?? members[0];
        const options = members.map((nodeId) => readOption(observation, nodeId));
        const component = baseComponent(observation, locators, {
            kind,
            rootNodeId,
            ownerNodeId: rootNodeId,
            controlNodeId: members[0],
            optionNodeIds: [...members],
            memberNodeIds: [rootNodeId, ...members],
            options,
            status: 'complete',
        });
        if (canExecute(component, locators, observation)) {component.capabilities.push('select_option');}
        add(controls, component);
        for (const option of options) {
            const optionComponent = baseComponent(observation, locators, {
                kind: 'option',
                rootNodeId: option.nodeId,
                ownerNodeId: rootNodeId,
                controlNodeId: option.nodeId,
                optionNodeIds: [option.nodeId],
                memberNodeIds: [option.nodeId],
                options: [option],
                status: option.disabled ? 'partial' : 'complete',
            });
            if (optionComponent.status === 'complete' && canExecute(optionComponent, locators, observation)) {
                optionComponent.capabilities.push('focus', 'click');
            }
            add(controls, optionComponent);
        }
        for (const member of members) {consumed.add(member);}
    }
};

const collectCustomSelects = (
    observation: PageObservation,
    relations: RelationIndex,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => {
    for (const nodeId of orderedNodeIds(observation)) {
        const role = resolveSemanticRole(observation, nodeId).value;
        if (role !== 'combobox') {continue;}
        if (observation.nodes[nodeId]?.tag === 'select') {continue;}
        const parts = resolveCustomSelectParts(observation, nodeId);
        const relationEdges = relationEdgesFrom(relations, nodeId)
            .filter((edge) => edge.kind === 'popup-owner' || edge.kind === 'controls-target');
        const ambiguous = relationEdges.some((edge) => edge.status === 'ambiguous');
        const resolvedPopupIds = unique(relationEdges
            .filter((edge) => edge.status === 'resolved')
            .flatMap((edge) => edge.targetNodeIds)
            .filter((targetId) => POPUP_ROLES.has(resolveSemanticRole(observation, targetId).value)));
        const popupNodeId = resolvedPopupIds.length === 1 ? resolvedPopupIds[0] : undefined;
        const options = popupNodeId ? resolveCustomSelectOptions(observation, popupNodeId) : [];
        const expanded = readExpanded(observation, nodeId);
        const completeness = scopeCompleteness(observation, nodeId);
        const factsComplete = completeness.a11y === 'complete' && completeness.runtime === 'complete';
        const optionsExecutable = options.length > 0
            && options.every((option) => isNodeInteractable(observation, option.nodeId));
        let status: ControlComponent['status'] = 'partial';
        if (ambiguous || resolvedPopupIds.length > 1) {
            status = 'ambiguous';
        } else if (popupNodeId && optionsExecutable && expanded && factsComplete) {
            status = 'complete';
        }
        const diagnostics: AnalysisDiagnostic[] = [];
        if (!factsComplete) {
            diagnostics.push(controlDiagnostic(
                'control.completeness.inherited',
                'warning',
                'partial',
                [nodeId, ...(popupNodeId ? [popupNodeId] : [])],
                [],
                'custom select requires runtime and accessibility facts for executable selection',
            ));
        }
        if (status === 'ambiguous') {
            diagnostics.push(controlDiagnostic(
                'control.custom-select.popup-ambiguous',
                'error',
                'ambiguous',
                [nodeId, ...resolvedPopupIds],
                [],
                'custom select popup ownership is not unique',
            ));
        }
        const component = baseComponent(observation, locators, {
            kind: 'custom_select',
            rootNodeId: parts.rootNodeId,
            ownerNodeId: parts.rootNodeId !== nodeId ? parts.rootNodeId : undefined,
            controlNodeId: nodeId,
            triggerNodeId: parts.triggerNodeId,
            popupNodeId,
            optionNodeIds: options.map((option) => option.nodeId),
            memberNodeIds: [
                parts.rootNodeId,
                parts.triggerNodeId,
                nodeId,
                ...(popupNodeId ? [popupNodeId] : []),
                ...options.flatMap((option) => [option.nodeId, option.semanticNodeId].filter((value): value is string => Boolean(value))),
            ],
            options,
            status,
            diagnostics,
        });
        if (canExecute(component, locators, observation)) {component.capabilities.push('open_popup');}
        if (status === 'complete' && options.every((option) => hasResolvedLocator(locators, option.nodeId))) {
            component.capabilities.push('select_option');
        }
        component.state.expanded = expanded;
        add(controls, component);
        for (const option of options) {
            if (hasControlForNodeKind(controls, option.nodeId, 'option')) {continue;}
            const optionComponent = baseComponent(observation, locators, {
                kind: 'option',
                rootNodeId: option.nodeId,
                controlNodeId: option.nodeId,
                ownerNodeId: popupNodeId,
                optionNodeIds: [option.nodeId],
                memberNodeIds: unique([option.nodeId, option.semanticNodeId].filter((value): value is string => Boolean(value))),
                options: [option],
                status: isNodeInteractable(observation, option.nodeId) ? 'complete' : 'partial',
            });
            if (optionComponent.status === 'complete' && canExecute(optionComponent, locators, observation)) {
                optionComponent.capabilities.push('click');
            }
            add(controls, optionComponent);
        }
        consumed.add(nodeId);
    }
};

const collectPopupAndOptions = (
    observation: PageObservation,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
) => {
    for (const nodeId of orderedNodeIds(observation)) {
        const role = resolveSemanticRole(observation, nodeId).value;
        if (POPUP_ROLES.has(role)) {
            if (observation.nodes[nodeId]?.tag === 'select') {continue;}
            const options = descendantIds(observation, nodeId)
                .filter((candidateId) => isOptionNode(observation, candidateId))
                .map((candidateId) => readOption(observation, candidateId));
            add(controls, baseComponent(observation, locators, {
                kind: 'popup', rootNodeId: nodeId, controlNodeId: nodeId,
                optionNodeIds: options.map((option) => option.nodeId), memberNodeIds: [nodeId, ...options.map((option) => option.nodeId)],
                options, status: 'complete',
            }));
        }
        if (isOptionNode(observation, nodeId)) {
            if (hasControlForNodeKind(controls, nodeId, 'option')) {continue;}
            const component = baseComponent(observation, locators, {
                kind: 'option', rootNodeId: nodeId, controlNodeId: nodeId,
                optionNodeIds: [nodeId], memberNodeIds: [nodeId], options: [readOption(observation, nodeId)],
                status: isNodeInteractable(observation, nodeId) ? 'complete' : 'partial',
            });
            if (component.status === 'complete' && canExecute(component, locators, observation)) {component.capabilities.push('click');}
            add(controls, component);
        }
    }
};

const collectAtomicControls = (
    observation: PageObservation,
    locators: LocatorIndex,
    controls: Record<string, ControlComponent>,
    consumed: Set<ObservationNodeId>,
) => {
    for (const nodeId of orderedNodeIds(observation)) {
        if (consumed.has(nodeId)) {continue;}
        const node = observation.nodes[nodeId];
        if (!node) {continue;}
        const role = resolveSemanticRole(observation, nodeId).value;
        const type = lower(observation.attributes[nodeId]?.type);
        let kind: ControlKind | undefined;
        if (node.tag === 'textarea') {kind = 'textarea';}
        else if (node.tag === 'input' && (type === 'hidden' || type === 'file')) {continue;}
        else if (node.tag === 'input' && ACTION_INPUT_TYPES.has(type)) {kind = 'button';}
        else if (node.tag === 'input' && DATE_TYPES.has(type)) {kind = 'date_like';}
        else if (node.tag === 'input') {kind = 'input';}
        else if (node.tag === 'button' || role === 'button') {kind = 'button';}
        else if ((node.tag === 'a' && typeof observation.attributes[nodeId]?.href === 'string') || role === 'link') {kind = 'link';}
        if (!kind) {continue;}
        const component = baseComponent(observation, locators, {
            kind, rootNodeId: nodeId, controlNodeId: nodeId,
            optionNodeIds: [], memberNodeIds: [nodeId], options: [], status: 'complete',
        });
        if (canExecute(component, locators, observation)) {
            component.capabilities.push('focus', 'click');
            if (kind === 'input' && (type === 'checkbox' || type === 'radio')) {
                component.capabilities.push('toggle');
            } else if ((kind === 'textarea' || kind === 'date_like' || (kind === 'input' && FILLABLE_INPUT_TYPES.has(type)))
                && !component.state.readonly) {
                component.capabilities.push('fill');
            }
        }
        add(controls, component);
    }
};

const baseComponent = (
    observation: PageObservation,
    locators: LocatorIndex,
    input: {
        kind: ControlKind;
        rootNodeId: ObservationNodeId;
        ownerNodeId?: ObservationNodeId;
        controlNodeId?: ObservationNodeId;
        triggerNodeId?: ObservationNodeId;
        popupNodeId?: ObservationNodeId;
        optionNodeIds: ObservationNodeId[];
        memberNodeIds: ObservationNodeId[];
        options: ControlOption[];
        status: ControlComponent['status'];
        diagnostics?: AnalysisDiagnostic[];
    },
): ControlComponent => {
    const scopeId = observation.nodes[input.rootNodeId]?.scopeId ?? '';
    const locatorIds = unique(input.memberNodeIds.flatMap((nodeId) => locators.byNodeId[nodeId] ?? []));
    const ref = controlRef(observation, input.kind, input.rootNodeId, input.controlNodeId);
    const state = readControlState(observation, input.controlNodeId ?? input.rootNodeId, input.options, input.kind);
    const inheritedCompleteness = scopeCompleteness(observation, input.rootNodeId);
    const factsComplete = inheritedCompleteness.a11y === 'complete' && inheritedCompleteness.runtime === 'complete';
    const diagnostics = [...(input.diagnostics ?? [])];
    if (!factsComplete && !diagnostics.some((item) => item.code === 'control.completeness.inherited')) {
        diagnostics.push(controlDiagnostic(
            'control.completeness.inherited', 'warning', 'partial', input.memberNodeIds, [],
            'control requires complete runtime and accessibility facts for executable capabilities',
        ));
    }
    const status = input.status === 'complete' && !factsComplete ? 'partial' : input.status;
    return {
        id: `control:${input.kind}:${input.rootNodeId}`,
        ref,
        kind: input.kind,
        status,
        scopeId,
        rootNodeId: input.rootNodeId,
        ownerNodeId: input.ownerNodeId,
        controlNodeId: input.controlNodeId,
        triggerNodeId: input.triggerNodeId,
        popupNodeId: input.popupNodeId,
        optionNodeIds: [...input.optionNodeIds],
        memberNodeIds: unique(input.memberNodeIds),
        capabilities: [] as ControlCapability[],
        state,
        options: input.options,
        inheritedCompleteness,
        locatorIds,
        evidence: [{
            code: `control.${input.kind}.collected`,
            strength: 'strong',
            source: 'dom',
            nodeIds: unique(input.memberNodeIds),
        }],
        diagnostics,
    };
};

const readControlState = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    options: readonly ControlOption[],
    kind: ControlKind,
): ControlState => {
    const runtime = observation.runtimeState[nodeId];
    const a11y = observation.accessibility[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    const grouped = kind === 'radio_group' || kind === 'checkbox_group';
    return {
        expanded: readExpanded(observation, nodeId),
        multiple: kind === 'checkbox_group' || hasBooleanAttribute(attrs, 'multiple'),
        disabled: grouped
            ? options.length > 0 && options.every((option) => option.disabled)
            : truthy(runtime?.disabled) || truthy(a11y?.disabled) || lower(attrs['aria-disabled']) === 'true' || hasBooleanAttribute(attrs, 'disabled'),
        readonly: truthy(runtime?.readonly) || truthy(a11y?.readonly) || lower(attrs['aria-readonly']) === 'true' || hasBooleanAttribute(attrs, 'readonly'),
        focused: truthy(runtime?.focused),
        checked: grouped
            ? options.some((option) => option.selected)
            : truthy(runtime?.checked) || truthy(runtime?.ariaChecked) || hasBooleanAttribute(attrs, 'checked'),
        selectedValues: options.filter((option) => option.selected).map((option) => option.value),
        selectedLabels: options.filter((option) => option.selected).map((option) => option.label),
    };
};

const readOption = (
    observation: PageObservation,
    semanticNodeId: ObservationNodeId,
    executionNodeId: ObservationNodeId = semanticNodeId,
    allowImplicitAccessibilitySelection = true,
): ControlOption => {
    const nodeId = semanticNodeId;
    const attrs = observation.attributes[nodeId] ?? {};
    const runtime = observation.runtimeState[nodeId];
    const a11y = observation.accessibility[nodeId];
    const text = readOptionText(observation, nodeId);
    const value = attrs.value ?? attrs['data-value'] ?? attrs['data-key'] ?? text ?? '';
    const label = attrs.label ?? a11y?.name ?? text ?? value;
    return {
        nodeId: executionNodeId,
        semanticNodeId: executionNodeId === semanticNodeId ? undefined : semanticNodeId,
        value,
        label,
        text,
        ariaLabel: attrs['aria-label'],
        title: attrs.title,
        dataValue: attrs['data-value'],
        dataKey: attrs['data-key'],
        selected: truthy(runtime?.selected) || truthy(runtime?.ariaSelected)
            || (allowImplicitAccessibilitySelection && truthy(a11y?.selected))
            || hasBooleanAttribute(attrs, 'selected') || lower(attrs['aria-selected']) === 'true'
            || truthy(runtime?.checked) || truthy(runtime?.ariaChecked) || hasBooleanAttribute(attrs, 'checked'),
        disabled: truthy(runtime?.disabled) || truthy(a11y?.disabled)
            || lower(attrs['aria-disabled']) === 'true' || hasBooleanAttribute(attrs, 'disabled'),
    };
};

const readOptionText = (observation: PageObservation, nodeId: ObservationNodeId): string | undefined => {
    const values = unique([nodeId, ...descendantIds(observation, nodeId)]
        .map((candidateId) => observation.text[candidateId]?.replace(/\s+/g, ' ').trim())
        .filter((value): value is string => Boolean(value)));
    return values.length > 0 ? values.join(' ') : undefined;
};

const controlRef = (
    observation: PageObservation,
    kind: ControlKind,
    rootNodeId: ObservationNodeId,
    controlNodeId?: ObservationNodeId,
): string => {
    const scopeId = observation.nodes[rootNodeId]?.scopeId ?? '';
    const rootAttrs = observation.attributes[rootNodeId] ?? {};
    const controlAttrs = observation.attributes[controlNodeId ?? rootNodeId] ?? {};
    if (typeof controlAttrs['data-rpa-control-ref'] === 'string' && controlAttrs['data-rpa-control-ref'].length > 0) {
        return controlAttrs['data-rpa-control-ref'];
    }
    const identityNodeId = kind === 'radio_group' || kind === 'checkbox_group'
        ? rootNodeId
        : controlNodeId ?? rootNodeId;
    const identity = observation.domIdentity[identityNodeId];
    if (identity?.backendNodeId) {return `backend:${observation.identity.pageEpoch}:${identity.backendNodeId}`;}
    if (identity?.runtimeIdentityToken) {return `runtime:${observation.identity.pageEpoch}:${identity.runtimeIdentityToken}`;}
    if (typeof rootAttrs.id === 'string' && rootAttrs.id.length > 0) {return `scope:${scopeId}:dom-id:${rootAttrs.id}`;}
    if (kind !== 'radio_group' && kind !== 'checkbox_group'
        && typeof controlAttrs.id === 'string' && controlAttrs.id.length > 0) {
        return `scope:${scopeId}:dom-id:${controlAttrs.id}`;
    }
    return `scope:${scopeId}:${kind}:${rootNodeId}`;
};

export const validateControlIndex = (
    controls: Record<string, ControlComponent>,
    byRef: Record<string, string[]>,
    locators: LocatorIndex,
): ControlInvariantValidation => {
    const diagnostics: AnalysisDiagnostic[] = [];
    for (const component of Object.values(controls)) {
        const resolvedLocatorCount = component.locatorIds
            .filter((locatorId) => locators.locators[locatorId]?.status === 'resolved').length;
        if (component.capabilities.length > 0 && resolvedLocatorCount === 0) {
            diagnostics.push(controlDiagnostic(
                'control.invariant.executable-without-locator', 'error', 'rejected', component.memberNodeIds, [],
                'executable control has no resolved canonical locator',
            ));
        }
        if (component.capabilities.includes('select_option') && component.status !== 'complete') {
            diagnostics.push(controlDiagnostic(
                'control.invariant.partial-select-option', 'error', component.status, component.memberNodeIds, [],
                'select_option capability requires complete assembly',
            ));
        }
        for (const locatorId of component.locatorIds) {
            if (!locators.locators[locatorId]) {
                diagnostics.push(controlDiagnostic(
                    'control.invariant.locator-missing', 'error', 'rejected', component.memberNodeIds, [],
                    `control references missing locator ${locatorId}`,
                ));
            }
        }
    }
    for (const [ref, ids] of Object.entries(byRef)) {
        if (ids.length <= 1) {continue;}
        if (ids.some((id) => controls[id]?.capabilities.length)) {
            diagnostics.push(controlDiagnostic(
                'control.invariant.duplicate-executable-ref', 'error', 'ambiguous',
                ids.flatMap((id) => controls[id]?.memberNodeIds ?? []), [],
                `duplicate control ref remains executable: ${ref}`,
            ));
        }
    }
    return deepFreeze({ ok: diagnostics.length === 0, diagnostics });
};

const canExecute = (component: ControlComponent, locators: LocatorIndex, observation: PageObservation): boolean => {
    if (component.status === 'ambiguous' || component.state.disabled
        || (component.inheritedCompleteness.runtime !== 'complete' || component.inheritedCompleteness.a11y !== 'complete')) {return false;}
    const candidateNodeIds = component.kind === 'radio_group' || component.kind === 'checkbox_group'
        ? component.options.filter((option) => !option.disabled).map((option) => option.nodeId)
        : [component.triggerNodeId ?? component.controlNodeId ?? component.rootNodeId];
    return candidateNodeIds.some((nodeId) => {
        const activity = observation.activity[nodeId];
        return Boolean(activity && activity.rendered && !activity.hiddenByStyle && !activity.inert
            && activity.selfHasBox && activity.subtreeActive && activity.ariaExposed !== false
            && (locators.byNodeId[nodeId] ?? []).some((locatorId) => locators.locators[locatorId]?.status === 'resolved'));
    });
};

const hasResolvedLocator = (locators: LocatorIndex, nodeId: ObservationNodeId): boolean =>
    (locators.byNodeId[nodeId] ?? []).some((id) => locators.locators[id]?.status === 'resolved');

const relationEdgesFrom = (relations: RelationIndex, nodeId: ObservationNodeId): RelationEdge[] =>
    (relations.bySourceNodeId[nodeId] ?? []).map((index) => relations.edges[index]).filter(Boolean);


const resolveCustomSelectOptions = (
    observation: PageObservation,
    popupNodeId: ObservationNodeId,
): ControlOption[] => {
    const semanticNodeIds = descendantIds(observation, popupNodeId)
        .filter((candidateId) => isOptionNode(observation, candidateId));
    if (semanticNodeIds.length === 0) {return [];}

    const dropdownRoot = nearestAncestorWithClass(observation, popupNodeId, 'ant-select-dropdown');
    if (dropdownRoot) {
        const visualNodeIds = descendantIds(observation, dropdownRoot)
            .filter((candidateId) => classTokens(observation.attributes[candidateId]?.class).includes('ant-select-item-option'))
            .filter((candidateId) => isNodeInteractable(observation, candidateId));
        if (visualNodeIds.length === semanticNodeIds.length && visualNodeIds.length > 0) {
            return semanticNodeIds.map((semanticNodeId, index) =>
                readOption(observation, semanticNodeId, visualNodeIds[index], false));
        }
    }
    return semanticNodeIds.map((semanticNodeId) => readOption(observation, semanticNodeId, semanticNodeId, false));
};

const nearestAncestorWithClass = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    className: string,
): ObservationNodeId | undefined => {
    let current: ObservationNodeId | undefined = nodeId;
    while (current) {
        if (classTokens(observation.attributes[current]?.class).includes(className)) {return current;}
        current = observation.parents[current];
    }
    return undefined;
};

const isNodeInteractable = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const activity = observation.activity[nodeId];
    return Boolean(activity && activity.rendered && !activity.hiddenByStyle && !activity.inert
        && activity.selfHasBox && activity.subtreeActive);
};

const hasControlForNodeKind = (
    controls: Record<string, ControlComponent>,
    nodeId: ObservationNodeId,
    kind: ControlKind,
): boolean => Object.values(controls).some((component) =>
    component.kind === kind && component.controlNodeId === nodeId);

const resolveCustomSelectParts = (
    observation: PageObservation,
    controlNodeId: ObservationNodeId,
): { rootNodeId: ObservationNodeId; triggerNodeId: ObservationNodeId } => {
    let rootNodeId = controlNodeId;
    let triggerNodeId = controlNodeId;
    let current = observation.parents[controlNodeId];
    while (current) {
        const classes = classTokens(observation.attributes[current]?.class);
        if (classes.some((token) => CUSTOM_SELECT_TRIGGER_CLASSES.has(token))) {
            triggerNodeId = current;
        }
        if (classes.some((token) => CUSTOM_SELECT_ROOT_CLASSES.has(token))) {
            rootNodeId = current;
            break;
        }
        const parent = observation.parents[current];
        if (!parent || observation.nodes[parent]?.scopeId !== observation.nodes[controlNodeId]?.scopeId) {break;}
        current = parent;
    }
    return { rootNodeId, triggerNodeId };
};

const findSafeBoundary = (
    observation: PageObservation,
    nodeId: ObservationNodeId,
    kind: 'radio_group' | 'checkbox_group',
): ObservationNodeId | undefined => {
    let current = observation.parents[nodeId];
    while (current) {
        const node = observation.nodes[current];
        if (!node) {break;}
        const attrs = observation.attributes[current] ?? {};
        const role = lower(attrs.role);
        const classes = classTokens(attrs.class);
        const explicit = typeof attrs['data-rpa-control-group'] === 'string';
        const tagBoundary = node.tag === 'fieldset' || (kind === 'radio_group' && node.tag === 'form');
        const roleBoundary = role === 'group' || (kind === 'radio_group' && role === 'radiogroup');
        const classBoundary = classes.some((token) => SAFE_GROUP_CLASSES.has(token));
        if (explicit || tagBoundary || roleBoundary || classBoundary) {return current;}
        current = observation.parents[current];
    }
    return undefined;
};

const resolveNativeFormOwner = (
    observation: PageObservation,
    relations: RelationIndex,
    nodeId: ObservationNodeId,
): string => {
    const edges = (relations.bySourceNodeId[nodeId] ?? [])
        .map((index) => relations.edges[index])
        .filter((edge) => edge?.kind === 'form-owner');
    if (edges.length > 0) {
        const resolved = unique(edges
            .filter((edge) => edge.status === 'resolved')
            .flatMap((edge) => edge.targetNodeIds)
            .filter((targetId) => observation.nodes[targetId]?.tag === 'form'));
        return resolved.length === 1 ? resolved[0] : `invalid:${nodeId}`;
    }
    let current = observation.parents[nodeId];
    while (current) {
        if (observation.nodes[current]?.tag === 'form') {return current;}
        current = observation.parents[current];
    }
    return `scope:${observation.nodes[nodeId]?.scopeId ?? ''}`;
};

const scopeCompleteness = (observation: PageObservation, nodeId: ObservationNodeId): ObservationCompleteness => {
    const scope = observation.scopes.scopes[observation.nodes[nodeId]?.scopeId ?? ''];
    return scope?.completeness ?? observation.completeness;
};

const readExpanded = (observation: PageObservation, nodeId: ObservationNodeId): boolean => {
    const runtime = observation.runtimeState[nodeId];
    const a11y = observation.accessibility[nodeId];
    const attrs = observation.attributes[nodeId] ?? {};
    return truthy(runtime?.ariaExpanded) || truthy(a11y?.expanded) || lower(attrs['aria-expanded']) === 'true';
};

const isOptionNode = (observation: PageObservation, nodeId: ObservationNodeId): boolean =>
    observation.nodes[nodeId]?.tag === 'option'
    || resolveSemanticRole(observation, nodeId).value === 'option'
    || typeof observation.attributes[nodeId]?.['aria-selected'] === 'string';

const directDescendants = (observation: PageObservation, nodeId: ObservationNodeId): ObservationNodeId[] =>
    [...(observation.children[nodeId] ?? [])];

const descendantIds = (observation: PageObservation, nodeId: ObservationNodeId): ObservationNodeId[] => {
    const result: ObservationNodeId[] = [];
    const stack = [...(observation.children[nodeId] ?? [])].reverse();
    while (stack.length > 0) {
        const current = stack.pop()!;
        result.push(current);
        stack.push(...[...(observation.children[current] ?? [])].reverse());
    }
    return result;
};

const add = (controls: Record<string, ControlComponent>, component: ControlComponent) => {
    let id = component.id;
    let sequence = 1;
    while (controls[id]) {sequence += 1; id = `${component.id}:${sequence}`;}
    component.id = id;
    controls[id] = component;
};

const controlDiagnostic = (
    code: string,
    severity: AnalysisDiagnostic['severity'],
    status: NonNullable<AnalysisDiagnostic['status']>,
    nodeIds: ObservationNodeId[],
    evidence: Evidence[],
    message: string,
): AnalysisDiagnostic => ({ code, severity, stage: 'control', status, nodeIds: unique(nodeIds), evidence, message });

const hasBooleanAttribute = (attrs: Readonly<Record<string, string>>, name: string): boolean =>
    Object.prototype.hasOwnProperty.call(attrs, name) && lower(attrs[name]) !== 'false';
const truthy = (value: string | undefined): boolean => lower(value) === 'true' || value === '1';
const lower = (value: string | undefined): string => (value ?? '').trim().toLowerCase();
const classTokens = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter(Boolean);
const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
const orderedNodeIds = (observation: PageObservation): ObservationNodeId[] =>
    Object.keys(observation.nodes).sort((a, b) =>
        (observation.documentOrder[a] ?? Number.MAX_SAFE_INTEGER)
        - (observation.documentOrder[b] ?? Number.MAX_SAFE_INTEGER));
const DATE_TYPES = new Set(['date', 'datetime-local', 'month', 'time', 'week']);
const ACTION_INPUT_TYPES = new Set(['button', 'image', 'reset', 'submit']);
const FILLABLE_INPUT_TYPES = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
const POPUP_ROLES = new Set(['listbox', 'menu', 'tree', 'grid']);
const CUSTOM_SELECT_TRIGGER_CLASSES = new Set(['el-select__wrapper', 'ant-select-selector']);
const CUSTOM_SELECT_ROOT_CLASSES = new Set(['el-select', 'ant-select']);
const SAFE_GROUP_CLASSES = new Set([
    'form-item', 'ant-form-item', 'el-form-item',
    'radio-group', 'ant-radio-group', 'el-radio-group',
    'checkbox-group', 'ant-checkbox-group', 'el-checkbox-group',
]);
