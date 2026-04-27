import { mergeNodeSemanticHints, setNodeAttr } from '../core/runtime_store';
import { getLogger } from '../../../../../logging/logger';
import { createEntityRuleDiagnosticCollector } from '../core/diagnostics';
import type {
    EntityBusinessInfo,
    EntityFormAction,
    EntityFormField,
    EntityIndex,
    EntityRecord,
    EntityRuleDiagnostic,
    NodeEntityRef,
    UnifiedNode,
} from '../core/types';
import { createEmptyBusinessEntityOverlay, mergeEntityBusinessInfo, mergeNodeBusinessHint } from './overlay';
import { matchEntityRules } from './matcher';
import type {
    BusinessEntityOverlay,
    EntityAnnotationRule,
    NodeBusinessHint,
    NormalizedEntityRuleBundle,
    ResolvedRuleBinding,
    RuleBindingEntityRef,
} from './types';

const log = getLogger('entity');

type ApplyBusinessEntityRulesInput = {
    root: UnifiedNode;
    entityIndex: EntityIndex;
    bundle?: NormalizedEntityRuleBundle;
};

export const applyBusinessEntityRules = (input: ApplyBusinessEntityRulesInput): BusinessEntityOverlay => {
    if (!input.bundle) {return createEmptyBusinessEntityOverlay();}
    log.info('entity.rules.apply.start', {
        profile: input.bundle.id,
        entityCount: Object.keys(input.entityIndex.entities).length,
    });
    const bindings = matchEntityRules(input.bundle, {
        root: input.root,
        entityIndex: input.entityIndex,
    });
    const overlay = applyEntityRuleBindings(input.bundle, input.root, input.entityIndex, bindings);
    log.info('entity.rules.apply.end', {
        profile: input.bundle.id,
        ruleBindingCount: Object.keys(overlay.byRuleId).length,
        entityInfoCount: Object.keys(overlay.byEntityId).length,
        nodeHintCount: Object.keys(overlay.nodeHintsByNodeId).length,
    });
    return overlay;
};

export const applyEntityRuleBindings = (
    bundle: NormalizedEntityRuleBundle,
    root: UnifiedNode,
    entityIndex: EntityIndex,
    bindings: Record<string, ResolvedRuleBinding>,
): BusinessEntityOverlay => {
    const overlay = createEmptyBusinessEntityOverlay();
    const diagnostics = createEntityRuleDiagnosticCollector();
    const nodeById = buildNodeById(root);

    for (const rule of bundle.matchRules) {
        const binding = bindings[rule.ruleId];
        if (!binding) {continue;}
        overlay.byRuleId[rule.ruleId] = binding;
        if (!binding.ok) {
            diagnostics.add({
                code: binding.matchedNodeIds.length === 0 ? 'RULE_MATCHED_ZERO' : 'RULE_MATCHED_MULTIPLE',
                level: binding.matchedNodeIds.length === 0 ? 'warning' : 'warning',
                message:
                    binding.matchedNodeIds.length === 0
                        ? `rule matched zero nodes: ${rule.ruleId}`
                        : `rule matched multiple nodes: ${rule.ruleId}`,
                profile: bundle.id,
                ruleId: rule.ruleId,
                nodeIds: binding.matchedNodeIds,
            });
            continue;
        }

        const annotation = bundle.annotationByRuleId[rule.ruleId];
        if (!annotation) {continue;}

        applyEntityInfoAnnotation(overlay, binding, annotation);
        applyLegacyNodeHintAnnotation(overlay, binding, annotation, entityIndex);
    }

    for (const rule of bundle.matchRules) {
        const binding = bindings[rule.ruleId];
        if (!binding?.ok) {continue;}
        const annotation = bundle.annotationByRuleId[rule.ruleId];
        if (!annotation) {continue;}
        applyFormBindingAnnotations(overlay, annotation, binding, bindings, diagnostics, bundle.id);
        applyTablePaginationAnnotations(overlay, annotation, binding, bindings, diagnostics, bundle.id);
    }

    overlay.diagnostics = diagnostics.list();
    materializeOverlayToNodeHints(overlay, nodeById);
    return overlay;
};

const applyEntityInfoAnnotation = (
    overlay: BusinessEntityOverlay,
    binding: ResolvedRuleBinding,
    annotation: EntityAnnotationRule,
) => {
    const patch: EntityBusinessInfo = {
        businessTag: annotation.businessTag,
        businessName: annotation.businessName,
        primaryKey: annotation.primaryKey
            ? {
                fieldKey: annotation.primaryKey.fieldKey,
                columns: annotation.primaryKey.columns ? [...annotation.primaryKey.columns] : undefined,
                source: 'annotation',
            }
            : undefined,
        columns: annotation.columns?.map((column) => ({
            ...column,
            source: 'annotation',
            actions: column.actions?.map((action) => ({ ...action })),
        })),
        pagination: annotation.pagination
            ? {
                nextAction: annotation.pagination.nextAction
                    ? { ...annotation.pagination.nextAction }
                    : undefined,
            }
            : undefined,
    };

    const hasEntityPatch = Boolean(
        patch.businessTag ||
            patch.businessName ||
            patch.primaryKey ||
            patch.columns ||
            patch.pagination,
    );
    if (!hasEntityPatch) {return;}

    for (const entityRef of binding.matchedEntityRefs) {
        overlay.byEntityId[entityRef.entityId] = mergeEntityBusinessInfo(overlay.byEntityId[entityRef.entityId], patch);
    }
};

const applyLegacyNodeHintAnnotation = (
    overlay: BusinessEntityOverlay,
    binding: ResolvedRuleBinding,
    annotation: EntityAnnotationRule,
    entityIndex: EntityIndex,
) => {
    if (!annotation.fieldKey && !annotation.actionIntent) {return;}

    const entityById = entityIndex.entities;

    for (const nodeId of binding.matchedNodeIds) {
        const preferredEntity = pickPreferredEntityRef(entityIndex, nodeId);
        const resolvedEntity = preferredEntity ? entityById[preferredEntity.entityId] : undefined;

        const patch: NodeBusinessHint = {
            fieldKey: annotation.fieldKey,
            actionIntent: annotation.actionIntent,
            entityNodeId: resolvedEntity ? getEntityNodeId(resolvedEntity) : undefined,
            entityKind: resolvedEntity?.kind,
        };

        overlay.nodeHintsByNodeId[nodeId] = mergeNodeBusinessHint(overlay.nodeHintsByNodeId[nodeId], patch);
    }
};

const applyFormBindingAnnotations = (
    overlay: BusinessEntityOverlay,
    annotation: EntityAnnotationRule,
    binding: ResolvedRuleBinding,
    bindings: Record<string, ResolvedRuleBinding>,
    diagnostics: { add: (diagnostic: EntityRuleDiagnostic) => void },
    profile: string,
) => {
    if ((annotation.fields?.length || 0) === 0 && (annotation.actions?.length || 0) === 0) {
        return;
    }

    for (const entityRef of binding.matchedEntityRefs) {
        bindFormFieldsForEntity(overlay, annotation, annotation.fields || [], entityRef, bindings, diagnostics, profile);
        bindFormActionsForEntity(overlay, annotation, annotation.actions || [], entityRef, bindings, diagnostics, profile);
    }
};

const bindFormFieldsForEntity = (
    overlay: BusinessEntityOverlay,
    annotation: EntityAnnotationRule,
    fields: EntityFormField[],
    entityRef: RuleBindingEntityRef,
    bindings: Record<string, ResolvedRuleBinding>,
    diagnostics: { add: (diagnostic: EntityRuleDiagnostic) => void },
    profile: string,
) => {
    if (fields.length === 0) {return;}
    const base = overlay.byEntityId[entityRef.entityId];
    const nextFormFields = (base?.formFields || []).map((field) => ({ ...field }));
    const fieldIndexByKey = new Map(nextFormFields.map((field, index) => [field.fieldKey, index]));

    for (const field of fields) {
        const businessTag = annotation.businessTag;
        if (field.controlRuleId && !Object.prototype.hasOwnProperty.call(bindings, field.controlRuleId)) {
            diagnostics.add({
                code: 'ANNOTATION_RULE_REF_NOT_FOUND',
                level: 'error',
                message: `annotation rule ref not found: ${field.controlRuleId}`,
                profile,
                ruleId: field.controlRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag,
                fieldKey: field.fieldKey,
                nodeIds: [entityRef.nodeId],
            });
        }
        if (field.labelRuleId && !Object.prototype.hasOwnProperty.call(bindings, field.labelRuleId)) {
            diagnostics.add({
                code: 'ANNOTATION_RULE_REF_NOT_FOUND',
                level: 'error',
                message: `annotation rule ref not found: ${field.labelRuleId}`,
                profile,
                ruleId: field.labelRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag,
                fieldKey: field.fieldKey,
                nodeIds: [entityRef.nodeId],
            });
        }
        const controlNodeId = pickFirstBoundNodeId(field.controlRuleId, bindings);
        const labelNodeId = pickFirstBoundNodeId(field.labelRuleId, bindings);

        if (field.controlRuleId && !controlNodeId) {
            diagnostics.add({
                code: 'FIELD_CONTROL_UNRESOLVED',
                level: 'warning',
                message: `field control node unresolved: ${field.fieldKey}`,
                profile,
                ruleId: field.controlRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag,
                fieldKey: field.fieldKey,
                nodeIds: [entityRef.nodeId],
            });
        }
        if (field.labelRuleId && !labelNodeId) {
            diagnostics.add({
                code: 'FIELD_LABEL_UNRESOLVED',
                level: 'info',
                message: `field label node unresolved: ${field.fieldKey}`,
                profile,
                ruleId: field.labelRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag,
                fieldKey: field.fieldKey,
                nodeIds: [entityRef.nodeId],
            });
        }

        const normalizedField: EntityFormField = {
            ...field,
            optionSource: field.optionSource ? { ...field.optionSource } : undefined,
            controlNodeId: controlNodeId || field.controlNodeId,
            labelNodeId: labelNodeId || field.labelNodeId,
        };
        if (!normalizedField.controlNodeId && !normalizedField.labelNodeId) {continue;}

        const existedIndex = fieldIndexByKey.get(field.fieldKey);
        if (existedIndex === undefined) {
            nextFormFields.push(normalizedField);
            fieldIndexByKey.set(field.fieldKey, nextFormFields.length - 1);
        } else {
            nextFormFields[existedIndex] = {
                ...nextFormFields[existedIndex],
                ...normalizedField,
            };
        }

        if (controlNodeId) {
            patchNodeHint(overlay, controlNodeId, {
                entityNodeId: entityRef.nodeId,
                entityKind: entityRef.kind,
                fieldKey: field.fieldKey,
                fieldRole: 'control',
                controlKind: field.kind,
            });
        }

        if (labelNodeId) {
            patchNodeHint(overlay, labelNodeId, {
                entityNodeId: entityRef.nodeId,
                entityKind: entityRef.kind,
                fieldKey: field.fieldKey,
                fieldRole: 'label',
            });
        }

        if (field.optionSource?.optionRuleId) {
            if (!Object.prototype.hasOwnProperty.call(bindings, field.optionSource.optionRuleId)) {
                diagnostics.add({
                    code: 'ANNOTATION_RULE_REF_NOT_FOUND',
                    level: 'error',
                    message: `annotation rule ref not found: ${field.optionSource.optionRuleId}`,
                    profile,
                    ruleId: field.optionSource.optionRuleId,
                    annotationId: annotation.ruleId,
                    entityId: entityRef.entityId,
                    businessTag,
                    fieldKey: field.fieldKey,
                    nodeIds: [entityRef.nodeId],
                });
            }
            const optionBinding = bindings[field.optionSource.optionRuleId];
            if (!optionBinding?.ok || optionBinding.matchedNodeIds.length === 0) {
                diagnostics.add({
                    code: 'OPTION_RULE_UNRESOLVED',
                    level: 'info',
                    message: `field option rule unresolved: ${field.fieldKey}`,
                    profile,
                    ruleId: field.optionSource.optionRuleId,
                    annotationId: annotation.ruleId,
                    entityId: entityRef.entityId,
                    businessTag,
                    fieldKey: field.fieldKey,
                    nodeIds: [entityRef.nodeId],
                });
            }
            for (const nodeId of optionBinding?.matchedNodeIds || []) {
                patchNodeHint(overlay, nodeId, {
                    entityNodeId: entityRef.nodeId,
                    entityKind: entityRef.kind,
                    fieldKey: field.fieldKey,
                    fieldRole: 'option',
                    controlKind: field.kind,
                });
            }
        }
    }

    overlay.byEntityId[entityRef.entityId] = mergeEntityBusinessInfo(overlay.byEntityId[entityRef.entityId], {
        formFields: nextFormFields,
    });
};

const bindFormActionsForEntity = (
    overlay: BusinessEntityOverlay,
    annotation: EntityAnnotationRule,
    actions: EntityFormAction[],
    entityRef: RuleBindingEntityRef,
    bindings: Record<string, ResolvedRuleBinding>,
    diagnostics: { add: (diagnostic: EntityRuleDiagnostic) => void },
    profile: string,
) => {
    if (actions.length === 0) {return;}
    const base = overlay.byEntityId[entityRef.entityId];
    const nextFormActions = (base?.formActions || []).map((action) => ({ ...action }));
    const actionIndexByIntent = new Map(nextFormActions.map((action, index) => [action.actionIntent, index]));

    for (const action of actions) {
        if (action.nodeRuleId && !Object.prototype.hasOwnProperty.call(bindings, action.nodeRuleId)) {
            diagnostics.add({
                code: 'ANNOTATION_RULE_REF_NOT_FOUND',
                level: 'error',
                message: `annotation rule ref not found: ${action.nodeRuleId}`,
                profile,
                ruleId: action.nodeRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag: annotation.businessTag,
                actionIntent: action.actionIntent,
                nodeIds: [entityRef.nodeId],
            });
        }
        const nodeId = pickFirstBoundNodeId(action.nodeRuleId, bindings);
        if (action.nodeRuleId && !nodeId) {
            diagnostics.add({
                code: 'FORM_ACTION_UNRESOLVED',
                level: 'warning',
                message: `form action node unresolved: ${action.actionIntent}`,
                profile,
                ruleId: action.nodeRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag: annotation.businessTag,
                actionIntent: action.actionIntent,
                nodeIds: [entityRef.nodeId],
            });
        }
        const normalizedAction: EntityFormAction = {
            ...action,
            nodeId: nodeId || action.nodeId,
        };
        if (!normalizedAction.nodeId) {continue;}

        const existedIndex = actionIndexByIntent.get(action.actionIntent);
        if (existedIndex === undefined) {
            nextFormActions.push(normalizedAction);
            actionIndexByIntent.set(action.actionIntent, nextFormActions.length - 1);
        } else {
            nextFormActions[existedIndex] = {
                ...nextFormActions[existedIndex],
                ...normalizedAction,
            };
        }

        if (nodeId) {
            patchNodeHint(overlay, nodeId, {
                entityNodeId: entityRef.nodeId,
                entityKind: entityRef.kind,
                actionIntent: action.actionIntent,
            });
        }
    }

    overlay.byEntityId[entityRef.entityId] = mergeEntityBusinessInfo(overlay.byEntityId[entityRef.entityId], {
        formActions: nextFormActions,
    });
};

const pickFirstBoundNodeId = (
    ruleId: string | undefined,
    bindings: Record<string, ResolvedRuleBinding>,
): string | undefined => {
    if (!ruleId) {return undefined;}
    const binding = bindings[ruleId];
    if (!binding?.ok) {return undefined;}
    return binding.matchedNodeIds[0];
};

const patchNodeHint = (overlay: BusinessEntityOverlay, nodeId: string, patch: NodeBusinessHint) => {
    overlay.nodeHintsByNodeId[nodeId] = mergeNodeBusinessHint(overlay.nodeHintsByNodeId[nodeId], patch);
};

const applyTablePaginationAnnotations = (
    overlay: BusinessEntityOverlay,
    annotation: EntityAnnotationRule,
    binding: ResolvedRuleBinding,
    bindings: Record<string, ResolvedRuleBinding>,
    diagnostics: { add: (diagnostic: EntityRuleDiagnostic) => void },
    profile: string,
) => {
    const nextAction = annotation.pagination?.nextAction;
    if (!nextAction) {return;}

    for (const entityRef of binding.matchedEntityRefs) {
        if (entityRef.kind !== 'table') {continue;}

        if (!Object.prototype.hasOwnProperty.call(bindings, nextAction.nodeRuleId)) {
            diagnostics.add({
                code: 'ANNOTATION_RULE_REF_NOT_FOUND',
                level: 'error',
                message: `annotation rule ref not found: ${nextAction.nodeRuleId}`,
                profile,
                ruleId: nextAction.nodeRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag: annotation.businessTag,
                actionIntent: nextAction.actionIntent,
                nodeIds: [entityRef.nodeId],
            });
            continue;
        }

        const nextBinding = bindings[nextAction.nodeRuleId];
        const nextNodeId = nextBinding?.matchedNodeIds[0];
        if (!nextNodeId) {
            diagnostics.add({
                code: 'TABLE_PAGINATION_NEXT_UNRESOLVED',
                level: 'warning',
                message: `table pagination next action unresolved: ${nextAction.actionIntent}`,
                profile,
                ruleId: nextAction.nodeRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag: annotation.businessTag,
                actionIntent: nextAction.actionIntent,
                nodeIds: [entityRef.nodeId],
            });
        } else if ((nextBinding?.matchedNodeIds.length || 0) > 1) {
            diagnostics.add({
                code: 'TABLE_PAGINATION_NEXT_AMBIGUOUS',
                level: 'warning',
                message: `table pagination next action matched multiple nodes: ${nextAction.actionIntent}`,
                profile,
                ruleId: nextAction.nodeRuleId,
                annotationId: annotation.ruleId,
                entityId: entityRef.entityId,
                businessTag: annotation.businessTag,
                actionIntent: nextAction.actionIntent,
                nodeIds: nextBinding?.matchedNodeIds,
            });
        }

        const disabledBinding = nextAction.disabledRuleId ? bindings[nextAction.disabledRuleId] : undefined;
        const disabledNodeId = disabledBinding?.matchedNodeIds[0];
        overlay.byEntityId[entityRef.entityId] = mergeEntityBusinessInfo(overlay.byEntityId[entityRef.entityId], {
            pagination: {
                nextAction: {
                    actionIntent: nextAction.actionIntent,
                    nodeRuleId: nextAction.nodeRuleId,
                    nodeId: nextNodeId,
                    disabledRuleId: nextAction.disabledRuleId,
                    disabledNodeId,
                },
            },
        });

        if (nextNodeId) {
            patchNodeHint(overlay, nextNodeId, {
                entityNodeId: entityRef.nodeId,
                entityKind: entityRef.kind,
                actionIntent: nextAction.actionIntent,
                actionRole: 'pagination.next',
            });
        }
    }
};

const materializeOverlayToNodeHints = (
    overlay: BusinessEntityOverlay,
    nodeById: Map<string, UnifiedNode>,
) => {
    for (const [nodeId, hint] of Object.entries(overlay.nodeHintsByNodeId)) {
        if (!hint) {continue;}
        const node = nodeById.get(nodeId);
        if (!node) {continue;}

        mergeNodeSemanticHints(node, hint);
        setNodeAttr(node, 'fieldKey', hint.fieldKey);
        setNodeAttr(node, 'fieldRole', hint.fieldRole);
        setNodeAttr(node, 'controlKind', hint.controlKind);
        setNodeAttr(node, 'actionIntent', hint.actionIntent);
        setNodeAttr(node, 'actionRole', hint.actionRole);
        setNodeAttr(node, 'entityNodeId', hint.entityNodeId);
        setNodeAttr(node, 'entityKind', hint.entityKind);
    }
};

const pickPreferredEntityRef = (entityIndex: EntityIndex, nodeId: string) => {
    const refs = entityIndex.byNodeId[nodeId] || [];
    let picked: NodeEntityRef | undefined;
    let score = Number.NEGATIVE_INFINITY;

    for (const ref of refs) {
        const entity = entityIndex.entities[ref.entityId];
        if (!entity) {continue;}
        let nextScore = 0;
        if (entity.type === 'region') {nextScore += 5;}
        if (ref.role === 'container') {nextScore += 3;}
        if (ref.role === 'item') {nextScore += 2;}
        if (ref.role === 'descendant') {nextScore += 1;}

        if (nextScore > score) {
            score = nextScore;
            picked = ref;
        }
    }

    return picked;
};

const getEntityNodeId = (entity: EntityRecord): string => (entity.type === 'region' ? entity.nodeId : entity.containerId);

const buildNodeById = (root: UnifiedNode): Map<string, UnifiedNode> => {
    const map = new Map<string, UnifiedNode>();
    const stack = [root];
    while (stack.length > 0) {
        const node = stack.pop();
        if (!node) {break;}
        map.set(node.id, node);
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return map;
};
