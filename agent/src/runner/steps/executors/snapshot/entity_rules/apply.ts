import { mergeNodeSemanticHints, setNodeAttr } from '../core/runtime_store';
import type { EntityBusinessInfo, EntityIndex, EntityRecord, NodeEntityRef, UnifiedNode } from '../core/types';
import { createEmptyBusinessEntityOverlay, mergeEntityBusinessInfo, mergeNodeBusinessHint } from './overlay';
import { matchEntityRules } from './matcher';
import type {
    BusinessEntityOverlay,
    EntityAnnotationRule,
    NodeBusinessHint,
    NormalizedEntityRuleBundle,
    ResolvedRuleBinding,
} from './types';

type ApplyBusinessEntityRulesInput = {
    root: UnifiedNode;
    entityIndex: EntityIndex;
    bundle?: NormalizedEntityRuleBundle;
};

export const applyBusinessEntityRules = (input: ApplyBusinessEntityRulesInput): BusinessEntityOverlay => {
    if (!input.bundle) return createEmptyBusinessEntityOverlay();
    const bindings = matchEntityRules(input.bundle, {
        root: input.root,
        entityIndex: input.entityIndex,
    });
    return applyEntityRuleBindings(input.bundle, input.root, input.entityIndex, bindings);
};

export const applyEntityRuleBindings = (
    bundle: NormalizedEntityRuleBundle,
    root: UnifiedNode,
    entityIndex: EntityIndex,
    bindings: Record<string, ResolvedRuleBinding>,
): BusinessEntityOverlay => {
    const overlay = createEmptyBusinessEntityOverlay();
    const nodeById = buildNodeById(root);

    for (const rule of bundle.matchRules) {
        const binding = bindings[rule.ruleId];
        if (!binding) continue;
        overlay.byRuleId[rule.ruleId] = binding;
        if (!binding.ok) continue;

        const annotation = bundle.annotationByRuleId[rule.ruleId];
        if (!annotation) continue;

        applyEntityInfoAnnotation(overlay, binding, annotation);
        applyNodeHintAnnotation(overlay, binding, annotation, entityIndex);
    }

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
            }
            : undefined,
        columns: annotation.columns?.map((column) => ({ ...column })),
    };

    const hasEntityPatch = Boolean(patch.businessTag || patch.businessName || patch.primaryKey || patch.columns);
    if (!hasEntityPatch) return;

    for (const entityRef of binding.matchedEntityRefs) {
        overlay.byEntityId[entityRef.entityId] = mergeEntityBusinessInfo(overlay.byEntityId[entityRef.entityId], patch);
    }
};

const applyNodeHintAnnotation = (
    overlay: BusinessEntityOverlay,
    binding: ResolvedRuleBinding,
    annotation: EntityAnnotationRule,
    entityIndex: EntityIndex,
) => {
    if (!annotation.fieldKey && !annotation.actionIntent) return;

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

const materializeOverlayToNodeHints = (
    overlay: BusinessEntityOverlay,
    nodeById: Map<string, UnifiedNode>,
) => {
    for (const [nodeId, hint] of Object.entries(overlay.nodeHintsByNodeId)) {
        if (!hint) continue;
        const node = nodeById.get(nodeId);
        if (!node) continue;

        mergeNodeSemanticHints(node, hint);
        setNodeAttr(node, 'fieldKey', hint.fieldKey);
        setNodeAttr(node, 'actionIntent', hint.actionIntent);
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
        if (!entity) continue;
        let nextScore = 0;
        if (entity.type === 'region') nextScore += 5;
        if (ref.role === 'container') nextScore += 3;
        if (ref.role === 'item') nextScore += 2;
        if (ref.role === 'descendant') nextScore += 1;

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
        if (!node) break;
        map.set(node.id, node);
        for (let index = node.children.length - 1; index >= 0; index -= 1) {
            stack.push(node.children[index]);
        }
    }
    return map;
};
