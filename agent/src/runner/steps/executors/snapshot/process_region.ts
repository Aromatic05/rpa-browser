import { applyLCA } from './lca';
import { compress } from './compress';
import type { NodeTier, SemanticNode, UnifiedNode } from './types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const entities = detectBusinessEntities(node);
    const tree = buildTree(node);

    markStrongSemantics(tree);
    applyLCA(tree, entities);
    rankTiers(tree);

    const compressed = compress(tree);
    if (!compressed) return null;
    return toUnifiedNode(compressed);
};

const detectBusinessEntities = (node: UnifiedNode): SemanticNode[] => {
    // 第二阶段最小实现：form/table/row/dialog/list item/card。
    const entities: SemanticNode[] = [];
    collectEntities(node, entities);
    return entities;
};

const buildTree = (node: UnifiedNode): SemanticNode => {
    // 区域初始树：当前直接从统一节点树映射。
    return toSemanticNode(node);
};

const markStrongSemantics = (tree: SemanticNode) => {
    // 强语义标记占位：input/button/link/checkbox/label/error。
    const strongRoles = new Set(['input', 'button', 'link', 'checkbox', 'label', 'error']);
    walk(tree, (node) => {
        if (strongRoles.has(node.role)) {
            node.tier = 'A';
        }
    });
};

const rankTiers = (tree: SemanticNode) => {
    // 节点价值分级占位：后续补完整规则。
    walk(tree, (node) => {
        if (node.tier) return;
        node.tier = defaultTier(node);
    });
};

const defaultTier = (_node: SemanticNode): NodeTier => 'B';

const walk = (node: SemanticNode, visitor: (node: SemanticNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const toSemanticNode = (node: UnifiedNode): SemanticNode => ({
    id: node.id,
    role: node.role,
    tier: 'B',
    name: node.name,
    content: node.content,
    target: node.target,
    bbox: node.bbox,
    attrs: node.attrs ? { ...node.attrs } : undefined,
    children: node.children.map((child) => toSemanticNode(child)),
});

const toUnifiedNode = (node: SemanticNode): UnifiedNode => ({
    id: node.id,
    role: node.role,
    name: node.name,
    content: node.content,
    target: node.target,
    bbox: node.bbox,
    attrs: node.attrs ? { ...node.attrs } : undefined,
    children: node.children.map((child) => toUnifiedNode(child)),
});

const collectEntities = (node: UnifiedNode, entities: SemanticNode[]) => {
    const entityType = detectEntityType(node);
    if (entityType) {
        const entityId = `entity:${node.id}`;
        node.attrs = {
            ...(node.attrs || {}),
            entity: 'true',
            entityType,
            entityId,
        };
        entities.push(toSemanticNode(node));
    }

    for (const child of node.children) {
        collectEntities(child, entities);
    }
};

const detectEntityType = (node: UnifiedNode): string | null => {
    const role = node.role.toLowerCase();
    const tag = inferTag(node);

    if (role === 'form' || tag === 'form') return 'form';
    if (role === 'row' || tag === 'tr') return 'row';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'listitem' || tag === 'li') return 'list_item';

    if (looksLikeCard(node)) return 'card';
    return null;
};

const looksLikeCard = (node: UnifiedNode): boolean => {
    if (node.children.length < 3) return false;
    if (!hasTextSignal(node)) return false;
    if (!hasInteractiveDescendant(node)) return false;
    return true;
};

const hasTextSignal = (node: UnifiedNode): boolean => {
    const hasSelfText = (node.content || node.name || '').trim().length > 0;
    if (hasSelfText) return true;
    return node.children.some((child) => hasTextSignal(child));
};

const hasInteractiveDescendant = (node: UnifiedNode): boolean => {
    if (INTERACTIVE_ROLES.has(node.role.toLowerCase())) return true;
    if (node.attrs?.onclick || node.attrs?.href || node.attrs?.tabindex) return true;
    return node.children.some((child) => hasInteractiveDescendant(child));
};

const inferTag = (node: UnifiedNode): string => {
    const attrs = node.attrs || {};
    const raw =
        attrs.tag ||
        attrs.tagName ||
        attrs.nodeName ||
        attrs.localName ||
        attrs['data-tag'] ||
        '';

    return raw.trim().toLowerCase();
};

const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'checkbox',
    'radio',
    'combobox',
    'menuitem',
    'option',
]);
