import { getNodeAttr, getNodeContent, mergeNodeSemanticHints, normalizeText } from './runtime_store';
import type { EntityKind, UnifiedNode } from './types';

export type BusinessEntitySeed = {
    nodeId: string;
    kind: EntityKind;
    name?: string;
};

export const applyLCA = (tree: UnifiedNode, entities: BusinessEntitySeed[]) => {
    const parentById = new Map<string, UnifiedNode | null>();
    const nodeById = new Map<string, UnifiedNode>();
    buildIndex(tree, null, parentById, nodeById);

    const entityByNodeId = new Map<string, BusinessEntitySeed>();
    for (const entity of entities) {
        entityByNodeId.set(entity.nodeId, entity);
    }

    forEachNode(tree, (node) => {
        if (!isLCATargetNode(node)) return;

        const nearest = findNearestEntity(node, parentById, entityByNodeId);
        if (!nearest) return;

        const fieldLabel = isFieldNode(node) ? inferFieldLabel(node, parentById) : undefined;
        const actionIntent = isActionNode(node) ? inferActionIntent(node, fieldLabel) : undefined;

        mergeNodeSemanticHints(node, {
            entityNodeId: nearest.nodeId,
            entityKind: nearest.kind,
            fieldLabel,
            actionIntent,
            actionTargetNodeId: isActionNode(node) ? nearest.nodeId : undefined,
        });
    });
};

const forEachNode = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        forEachNode(child, visitor);
    }
};

const buildIndex = (
    node: UnifiedNode,
    parent: UnifiedNode | null,
    parentById: Map<string, UnifiedNode | null>,
    nodeById: Map<string, UnifiedNode>,
) => {
    parentById.set(node.id, parent);
    nodeById.set(node.id, node);
    for (const child of node.children) {
        buildIndex(child, node, parentById, nodeById);
    }
};

const isLCATargetNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    if (FIELD_ROLES.has(role) || ACTION_ROLES.has(role)) return true;

    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    if (FIELD_TAGS.has(tag) || ACTION_TAGS.has(tag)) return true;
    return false;
};

const findNearestEntity = (
    node: UnifiedNode,
    parentById: Map<string, UnifiedNode | null>,
    entityByNodeId: Map<string, BusinessEntitySeed>,
): BusinessEntitySeed | undefined => {
    let cursor: UnifiedNode | null = node;
    while (cursor) {
        const entity = entityByNodeId.get(cursor.id);
        if (entity) return entity;
        cursor = parentById.get(cursor.id) || null;
    }
    return undefined;
};

const inferFieldLabel = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): string | undefined => {
    const explicit = pickExplicitFieldLabel(node);
    if (explicit) return explicit;

    const parent = parentById.get(node.id) || null;
    if (!parent) return undefined;
    const index = parent.children.findIndex((child) => child.id === node.id);
    if (index <= 0) return undefined;

    for (let i = index - 1; i >= 0; i -= 1) {
        const text = firstReadableText(parent.children[i], 2);
        if (text) return text;
    }
    return undefined;
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const attrs = [getNodeAttr(node, 'aria-label'), getNodeAttr(node, 'placeholder'), getNodeAttr(node, 'title')];
    for (const value of attrs) {
        const normalized = normalizeText(value);
        if (normalized) return normalized;
    }
    return undefined;
};

const inferActionIntent = (node: UnifiedNode, fieldLabel: string | undefined): string | undefined => {
    const text = [node.name, getNodeContent(node), fieldLabel, getNodeAttr(node, 'aria-label'), getNodeAttr(node, 'title')]
        .map((item) => normalizeText(item))
        .filter((item): item is string => Boolean(item))
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

const firstReadableText = (node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;

        const text = normalizeText(current.node.name || getNodeContent(current.node));
        if (text && text.length <= 48) return text;
        if (current.depth >= depthLimit) continue;

        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const isFieldNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
};

const isActionNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return ACTION_ROLES.has(role) || ACTION_TAGS.has(tag);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_TAGS = new Set(['button', 'a']);
const ACTION_INTENT_KEYWORDS: Array<[string, string[]]> = [
    ['search', ['search', 'find', '查询', '搜索']],
    ['filter', ['filter', '筛选']],
    ['delete', ['delete', 'remove', '删除', '移除']],
    ['edit', ['edit', 'update', '编辑', '修改']],
    ['create', ['create', 'new', 'add', '新增', '创建', '添加']],
    ['save', ['save', '保存']],
    ['close', ['close', 'cancel', '关闭', '取消']],
];
