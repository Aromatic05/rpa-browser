import type { UnifiedNode } from './types';

export const finalizeLabel = (tree: UnifiedNode): UnifiedNode => {
    const parentById = new Map<string, UnifiedNode | null>();
    buildParentIndex(tree, null, parentById);

    normalizeSemanticTexts(tree);
    migrateSemanticPayload(tree, parentById);
    applyLocalRejudge(tree, parentById);
    repairSemanticReferences(tree, parentById);
    return tree;
};

const buildParentIndex = (node: UnifiedNode, parent: UnifiedNode | null, parentById: Map<string, UnifiedNode | null>) => {
    parentById.set(node.id, parent);
    for (const child of node.children) {
        buildParentIndex(child, node, parentById);
    }
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeSemanticTexts = (tree: UnifiedNode) => {
    walk(tree, (node) => {
        node.name = normalizeText(node.name);
        node.content = normalizeText(node.content);

        if (isActionCarrier(node)) {
            const text = pickActionText(node);
            if (text) {
                if (!node.name) node.name = text;
                if (!node.content) node.content = text;
            }
            return;
        }

        if (isContainerCarrier(node)) {
            if (node.name && !node.content) {
                node.content = node.name;
            } else if (!node.name && node.content) {
                node.name = node.content;
            }
        }
    });
};

const migrateSemanticPayload = (tree: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    walk(tree, (node) => {
        migrateEntityIdPayload(node, parentById);
        migrateEntityTypePayload(node, parentById);
        migrateFieldLabel(node, parentById);
        migrateActionPayload(node, parentById);
    });
};

const migrateEntityIdPayload = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const entityId = normalizeText(node.entityId || node.attrs?.entityId);
    if (!entityId) return;
    if (isEntityIdCarrier(node)) return;

    const receiver = findNearestCarrier(node, parentById, isEntityIdCarrier);
    if (!receiver || receiver.id === node.id) return;
    if (!normalizeText(receiver.entityId || receiver.attrs?.entityId)) {
        setEntityId(receiver, entityId);
    }
    clearEntityId(node);
};

const migrateEntityTypePayload = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const entityType = normalizeText(node.entityType || node.attrs?.entityType);
    const parentEntityId = normalizeText(node.parentEntityId || node.attrs?.parentEntityId);
    if (!entityType && !parentEntityId) return;
    if (isEntityBoundaryCarrier(node)) return;

    const receiver = findNearestCarrier(node, parentById, isEntityBoundaryCarrier);
    if (!receiver || receiver.id === node.id) return;

    if (entityType && !normalizeText(receiver.entityType || receiver.attrs?.entityType)) {
        setEntityType(receiver, entityType);
    }
    if (parentEntityId && !normalizeText(receiver.parentEntityId || receiver.attrs?.parentEntityId)) {
        setParentEntityId(receiver, parentEntityId);
    }
    clearEntityType(node);
    clearParentEntityId(node);
};

const migrateFieldLabel = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const fieldLabel = normalizeText(node.fieldLabel || node.attrs?.fieldLabel);
    if (!fieldLabel) return;
    if (isFieldCarrier(node)) return;

    const receiver = findNearestCarrier(node, parentById, isFieldCarrier);
    if (!receiver || receiver.id === node.id) return;
    if (!normalizeText(receiver.fieldLabel || receiver.attrs?.fieldLabel)) {
        setFieldLabel(receiver, fieldLabel);
    }
    clearFieldLabel(node);
};

const migrateActionPayload = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const actionIntent = normalizeText(node.actionIntent || node.attrs?.actionIntent);
    const actionTargetId = normalizeText(node.actionTargetId || node.attrs?.actionTargetId);
    if (!actionIntent && !actionTargetId) return;
    if (isActionCarrier(node)) return;

    const receiver = findNearestCarrier(node, parentById, isActionCarrier);
    if (!receiver || receiver.id === node.id) return;

    if (actionIntent && !normalizeText(receiver.actionIntent || receiver.attrs?.actionIntent)) {
        setActionIntent(receiver, actionIntent);
    }
    if (actionTargetId && !normalizeText(receiver.actionTargetId || receiver.attrs?.actionTargetId)) {
        setActionTargetId(receiver, actionTargetId);
    }
    clearActionIntent(node);
    clearActionTargetId(node);
};

const applyLocalRejudge = (tree: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    walk(tree, (node) => {
        if (isActionCarrier(node)) {
            finalizeActionNode(node);
        }
        if (isFieldCarrier(node)) {
            finalizeFieldNode(node, parentById);
        }
        if (isContainerCarrier(node)) {
            finalizeContainerNode(node);
        }
    });
};

const repairSemanticReferences = (tree: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const entityIndex = buildEntityIndex(tree);
    if (entityIndex.size === 0) return;

    walk(tree, (node) => {
        repairParentEntityReference(node, parentById, entityIndex);
        repairActionTargetReference(node, parentById, entityIndex);
    });
};

const buildEntityIndex = (tree: UnifiedNode): Map<string, UnifiedNode> => {
    const entities = new Map<string, UnifiedNode>();
    walk(tree, (node) => {
        const entityId = normalizeText(node.entityId || node.attrs?.entityId);
        if (!entityId) return;
        entities.set(entityId, node);
    });
    return entities;
};

const repairParentEntityReference = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityIndex: Map<string, UnifiedNode>,
) => {
    const current = normalizeText(node.parentEntityId || node.attrs?.parentEntityId);
    const fallback = findNearestAncestorEntityId(node, parentById, entityIndex);

    if (!current) {
        if (fallback) setParentEntityId(node, fallback);
        return;
    }

    if (entityIndex.has(current)) return;
    if (fallback) {
        setParentEntityId(node, fallback);
        return;
    }
    clearParentEntityId(node);
};

const repairActionTargetReference = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityIndex: Map<string, UnifiedNode>,
) => {
    const current = normalizeText(node.actionTargetId || node.attrs?.actionTargetId);
    if (current && entityIndex.has(current)) return;

    const fallback = findActionTargetFallback(node, parentById, entityIndex);
    if (fallback) {
        setActionTargetId(node, fallback);
        return;
    }
    if (current) {
        clearActionTargetId(node);
    }
};

const findNearestAncestorEntityId = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityIndex: Map<string, UnifiedNode>,
): string | undefined => {
    let cursor = parentById.get(node.id) || null;
    while (cursor) {
        const entityId = normalizeText(cursor.entityId || cursor.attrs?.entityId);
        if (entityId && entityIndex.has(entityId)) return entityId;
        cursor = parentById.get(cursor.id) || null;
    }
    return undefined;
};

const findActionTargetFallback = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityIndex: Map<string, UnifiedNode>,
): string | undefined => {
    const ownEntityId = normalizeText(node.entityId || node.attrs?.entityId);
    if (ownEntityId && entityIndex.has(ownEntityId)) return ownEntityId;

    const parentEntityId = normalizeText(node.parentEntityId || node.attrs?.parentEntityId);
    if (parentEntityId && entityIndex.has(parentEntityId)) return parentEntityId;

    let firstEntity: string | undefined;
    let cursor = parentById.get(node.id) || null;
    while (cursor) {
        const candidateId = normalizeText(cursor.entityId || cursor.attrs?.entityId);
        if (!candidateId || !entityIndex.has(candidateId)) {
            cursor = parentById.get(cursor.id) || null;
            continue;
        }

        if (!firstEntity) {
            firstEntity = candidateId;
        }

        const entityType = normalizeRole(cursor.entityType || cursor.attrs?.entityType);
        const tableRole = normalizeRole(cursor.tableRole || cursor.attrs?.tableRole);
        if (ACTION_TARGET_ENTITY_TYPES.has(entityType) || tableRole === 'row') {
            return candidateId;
        }
        cursor = parentById.get(cursor.id) || null;
    }

    return firstEntity;
};

const finalizeActionNode = (node: UnifiedNode) => {
    const actionText = pickActionText(node);
    if (actionText) {
        if (!node.name) node.name = actionText;
        if (!node.content) node.content = actionText;
    }

    const inferred = inferActionIntent(node, actionText);
    if (!inferred) return;

    const current = normalizeText(node.actionIntent || node.attrs?.actionIntent);
    if (!current || shouldReplaceActionIntent(current, inferred)) {
        setActionIntent(node, inferred);
    }
};

const finalizeFieldNode = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const current = normalizeText(node.fieldLabel || node.attrs?.fieldLabel);
    if (current) {
        setFieldLabel(node, current);
        return;
    }

    const explicit = pickExplicitFieldLabel(node);
    if (explicit) {
        setFieldLabel(node, explicit);
        return;
    }

    const local = findLocalFieldLabel(node, parentById);
    if (local) {
        setFieldLabel(node, local);
    }
};

const finalizeContainerNode = (node: UnifiedNode) => {
    const own = normalizeText(node.name || node.content);
    if (own) {
        if (!node.name) node.name = own;
        if (!node.content) node.content = own;
        return;
    }

    const title = findContainerTitle(node);
    if (!title) return;
    node.name = title;
    node.content = title;
};

const findLocalFieldLabel = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): string | undefined => {
    const parent = parentById.get(node.id) || null;
    if (parent) {
        const index = parent.children.findIndex((child) => child.id === node.id);
        if (index > 0) {
            for (let i = index - 1; i >= 0; i -= 1) {
                const text = firstReadableText(parent.children[i], 2);
                if (text) return text;
            }
        }
    }

    const scope = findNearestFieldScope(node, parentById);
    if (!scope) return undefined;
    return findScopeLabelText(scope, node.id);
};

const findNearestFieldScope = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): UnifiedNode | null => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        if (isFieldScopeBoundary(cursor)) return cursor;
        cursor = parentById.get(cursor.id) || null;
    }
    return null;
};

const findScopeLabelText = (scope: UnifiedNode, skipNodeId: string): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node: scope, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (current.node.id !== skipNodeId && isLabelLikeNode(current.node)) {
            const text = normalizeText(current.node.name || current.node.content);
            if (text && text.length <= 48) return text;
        }
        if (current.depth >= 3) continue;
        for (const child of current.node.children) {
            if (child.id === skipNodeId) continue;
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const findContainerTitle = (node: UnifiedNode): string | undefined => {
    for (const child of node.children) {
        if (!isLabelLikeNode(child)) continue;
        const text = normalizeText(child.name || child.content);
        if (text && text.length <= 64) return text;
    }

    const queue: Array<{ node: UnifiedNode; depth: number }> = node.children.map((child) => ({ node: child, depth: 1 }));
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (current.depth > 2) continue;
        if (isLabelLikeNode(current.node)) {
            const text = normalizeText(current.node.name || current.node.content);
            if (text && text.length <= 64) return text;
        }
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }

    return undefined;
};

const firstReadableText = (node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        const own = normalizeText(current.node.name || current.node.content);
        if (own && own.length <= 48 && !isActionCarrier(current.node)) {
            return own;
        }
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const pickActionText = (node: UnifiedNode): string | undefined => {
    const candidates = [
        node.name,
        node.content,
        node.attrs?.['aria-label'],
        node.attrs?.title,
        firstReadableText(node, 2),
    ]
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value));

    return candidates.find((value) => value.length <= 64) || candidates[0];
};

const inferActionIntent = (node: UnifiedNode, actionText: string | undefined): string | undefined => {
    const text = [
        actionText,
        node.fieldLabel,
        node.attrs?.['aria-label'],
        node.attrs?.title,
    ]
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();

    for (const [intent, keywords] of ACTION_INTENT_KEYWORDS) {
        if (keywords.some((keyword) => text.includes(keyword))) {
            return intent;
        }
    }

    const role = normalizeRole(node.role);
    if (role === 'link') return 'open';
    if (role === 'button') return 'submit';
    return undefined;
};

const shouldReplaceActionIntent = (current: string, next: string): boolean => {
    if (current === next) return false;
    if (GENERIC_ACTION_INTENTS.has(current) && !GENERIC_ACTION_INTENTS.has(next)) return true;
    return false;
};

const findNearestCarrier = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    predicate: (candidate: UnifiedNode) => boolean,
): UnifiedNode | null => {
    const descendant = findNearestDescendant(node, predicate);
    if (descendant) return descendant;

    let cursor = parentById.get(node.id) || null;
    while (cursor) {
        if (predicate(cursor)) return cursor;
        cursor = parentById.get(cursor.id) || null;
    }
    return null;
};

const findNearestDescendant = (
    node: UnifiedNode,
    predicate: (candidate: UnifiedNode) => boolean,
): UnifiedNode | null => {
    const queue = node.children.map((child) => ({ node: child, depth: 1 }));
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;
        if (predicate(current.node)) return current.node;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return null;
};

const isSemanticCarrier = (node: UnifiedNode): boolean => {
    if (isActionCarrier(node)) return true;
    if (isFieldCarrier(node)) return true;
    if (isContainerCarrier(node)) return true;
    if (normalizeRole(node.attrs?.strongSemantic) === 'true') return true;
    if (normalizeText(node.entityId || node.attrs?.entityId)) return true;
    if (normalizeText(node.entityType || node.attrs?.entityType)) return true;
    return false;
};

const isActionCarrier = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    if (ACTION_ROLES.has(role)) return true;
    if (ACTION_TAGS.has(tag)) return true;
    return false;
};

const isFieldCarrier = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    if (FIELD_ROLES.has(role)) return true;
    if (FIELD_TAGS.has(tag)) return true;
    if (formRole === 'field') return true;
    return false;
};

const isContainerCarrier = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const entityType = normalizeRole(node.entityType || node.attrs?.entityType);
    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    if (CONTAINER_ROLES.has(role)) return true;
    if (CONTAINER_ENTITY_TYPES.has(entityType)) return true;
    if (formRole === 'field_group' || formRole === 'field') return true;
    return false;
};

const isEntityBoundaryCarrier = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const entityType = normalizeRole(node.entityType || node.attrs?.entityType);
    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    const tableRole = normalizeRole(node.tableRole || node.attrs?.tableRole);
    if (ENTITY_BOUNDARY_ROLES.has(role)) return true;
    if (CONTAINER_ENTITY_TYPES.has(entityType)) return true;
    if (formRole === 'form' || formRole === 'field_group') return true;
    if (tableRole === 'table' || tableRole === 'row') return true;
    return false;
};

const isEntityIdCarrier = (node: UnifiedNode): boolean => {
    if (isActionCarrier(node)) return true;
    if (isFieldCarrier(node)) return true;
    if (isEntityBoundaryCarrier(node)) return true;
    if (isContainerCarrier(node)) return true;
    if (normalizeRole(node.attrs?.strongSemantic) === 'true') return true;
    return false;
};

const isFieldScopeBoundary = (node: UnifiedNode): boolean => {
    const entityType = normalizeRole(node.entityType || node.attrs?.entityType);
    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    const tableRole = normalizeRole(node.tableRole || node.attrs?.tableRole);
    const role = normalizeRole(node.role);

    if (formRole === 'form' || formRole === 'field_group' || formRole === 'field') return true;
    if (tableRole === 'row') return true;
    if (FIELD_SCOPE_ENTITY_TYPES.has(entityType)) return true;
    if (FIELD_SCOPE_ROLES.has(role)) return true;
    return false;
};

const isLabelLikeNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tableRole = normalizeRole(node.tableRole || node.attrs?.tableRole);
    const tag = inferTag(node);
    if (LABEL_ROLES.has(role)) return true;
    if (tableRole === 'header_cell') return true;
    if (tag === 'label') return true;
    if (normalizeText(node.attrs?.labelFor || node.attrs?.for)) return true;
    return false;
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const attrs = node.attrs || {};
    const candidates = [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.label, attrs.name];
    for (const candidate of candidates) {
        const text = normalizeText(candidate);
        if (text) return text;
    }
    return undefined;
};

const setFieldLabel = (node: UnifiedNode, value: string) => {
    node.fieldLabel = value;
    node.attrs = {
        ...(node.attrs || {}),
        fieldLabel: value,
    };
};

const setEntityId = (node: UnifiedNode, value: string) => {
    node.entityId = value;
    node.attrs = {
        ...(node.attrs || {}),
        entityId: value,
    };
};

const setEntityType = (node: UnifiedNode, value: string) => {
    node.entityType = value;
    node.attrs = {
        ...(node.attrs || {}),
        entityType: value,
    };
};

const setParentEntityId = (node: UnifiedNode, value: string) => {
    node.parentEntityId = value;
    node.attrs = {
        ...(node.attrs || {}),
        parentEntityId: value,
    };
};

const setActionIntent = (node: UnifiedNode, value: string) => {
    node.actionIntent = value;
    node.attrs = {
        ...(node.attrs || {}),
        actionIntent: value,
    };
};

const setActionTargetId = (node: UnifiedNode, value: string) => {
    node.actionTargetId = value;
    node.attrs = {
        ...(node.attrs || {}),
        actionTargetId: value,
    };
};

const clearFieldLabel = (node: UnifiedNode) => {
    delete node.fieldLabel;
    if (node.attrs) delete node.attrs.fieldLabel;
};

const clearEntityId = (node: UnifiedNode) => {
    delete node.entityId;
    if (node.attrs) delete node.attrs.entityId;
};

const clearEntityType = (node: UnifiedNode) => {
    delete node.entityType;
    if (node.attrs) delete node.attrs.entityType;
};

const clearParentEntityId = (node: UnifiedNode) => {
    delete node.parentEntityId;
    if (node.attrs) delete node.attrs.parentEntityId;
};

const clearActionIntent = (node: UnifiedNode) => {
    delete node.actionIntent;
    if (node.attrs) delete node.attrs.actionIntent;
};

const clearActionTargetId = (node: UnifiedNode) => {
    delete node.actionTargetId;
    if (node.attrs) delete node.attrs.actionTargetId;
};

const inferTag = (node: UnifiedNode): string => {
    const attrs = node.attrs || {};
    const raw = attrs.tag || attrs.tagName || attrs.nodeName || attrs.localName || attrs['data-tag'] || '';
    return normalizeRole(raw);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
};

const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_TAGS = new Set(['button', 'a']);
const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const CONTAINER_ROLES = new Set(['row', 'dialog', 'alertdialog', 'listitem']);
const CONTAINER_ENTITY_TYPES = new Set(['row', 'card', 'dialog', 'list_item', 'field_group', 'section', 'form', 'table']);
const ENTITY_BOUNDARY_ROLES = new Set(['form', 'table', 'row', 'dialog', 'alertdialog', 'list', 'listitem', 'section']);
const LABEL_ROLES = new Set(['label', 'heading', 'columnheader', 'rowheader']);
const FIELD_SCOPE_ROLES = new Set(['form', 'row', 'dialog', 'listitem', 'section']);
const FIELD_SCOPE_ENTITY_TYPES = new Set(['form', 'field_group', 'row', 'card', 'dialog', 'list_item', 'section']);
const GENERIC_ACTION_INTENTS = new Set(['submit', 'open']);
const ACTION_INTENT_KEYWORDS: Array<[string, string[]]> = [
    ['search', ['search', 'find', '查询', '搜索']],
    ['filter', ['filter', '筛选']],
    ['delete', ['delete', 'remove', '删除', '移除']],
    ['edit', ['edit', 'update', '编辑', '修改']],
    ['create', ['create', 'new', 'add', '新增', '创建', '添加']],
    ['save', ['save', '保存']],
    ['close', ['close', 'cancel', '关闭', '取消']],
];
const ACTION_TARGET_ENTITY_TYPES = new Set(['row', 'list_item', 'card', 'dialog', 'section', 'form']);
