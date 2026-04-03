import { applyLCA } from './lca';
import { compress } from './compress';
import type { UnifiedNode } from './types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    // 第一阶段占位：保留链路，不实现复杂实体检测/分级逻辑。
    const entities = detectBusinessEntities(node);
    const tree = buildTree(node);

    markStrongSemantics(tree);
    applyLCA(tree, entities);
    rankTiers(tree);

    const compressed = compress(tree);
    if (!compressed) return null;
    return compressed;
};

const detectBusinessEntities = (node: UnifiedNode): UnifiedNode[] => {
    // 业务实体占位：form、field group、table、row、card、dialog。
    return node.children;
};

const buildTree = (node: UnifiedNode): UnifiedNode => {
    // 区域初始树：当前直接从统一节点树映射。
    return node;
};

const markStrongSemantics = (tree: UnifiedNode) => {
    // 强语义标记占位：input/button/link/checkbox/label/error。
    void tree;
};

const rankTiers = (tree: UnifiedNode) => {
    // 节点价值分级占位：后续补完整规则。
    void tree;
};
