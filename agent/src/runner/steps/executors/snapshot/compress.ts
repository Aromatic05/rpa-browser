import type { SemanticNode } from './types';

export const compress = (node: SemanticNode): SemanticNode | null => {
    node.children = node.children
        .map((child) => compress(child))
        .filter((child): child is SemanticNode => Boolean(child));

    // D 类节点直接删除。
    if (isDeleteTier(node)) return null;

    // C 类壳层折叠：尽量把有效子节点上提。
    if (isCollapsibleShell(node)) return liftChildren(node);

    // 复杂低价值子树做摘要。
    if (shouldSummarize(node)) return summarize(node);

    return node;
};

const isDeleteTier = (node: SemanticNode) => node.tier === 'D';

const isCollapsibleShell = (node: SemanticNode) => node.tier === 'C' && node.children.length > 0;

const liftChildren = (node: SemanticNode): SemanticNode => {
    if (node.children.length === 1) {
        return node.children[0];
    }
    return node;
};

const shouldSummarize = (_node: SemanticNode) => {
    // 占位：后续补摘要触发条件。
    return false;
};

const summarize = (node: SemanticNode): SemanticNode => ({
    ...node,
    children: [],
});
