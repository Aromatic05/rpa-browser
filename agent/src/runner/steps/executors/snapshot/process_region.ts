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
    // 业务实体占位：form、field group、table、row、card、dialog。
    return node.children.map((child) => toSemanticNode(child));
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
    text: node.text,
    children: node.children.map((child) => toSemanticNode(child)),
});

const toUnifiedNode = (node: SemanticNode): UnifiedNode => ({
    id: node.id,
    role: node.role,
    name: node.name,
    text: node.text,
    children: node.children.map((child) => toUnifiedNode(child)),
});
