import type { SemanticNode } from './types';

export const applyLCA = (tree: SemanticNode, entities: SemanticNode[]) => {
    // 对弱语义但重要的节点做最近业务实体归因，再扫描局部上下文。
    forEachNode(tree, (node) => {
        if (!isWeakSemanticNode(node)) return;
        const entity = findNearestEntity(node, entities);
        if (!entity) return;
        const context = scanEntityContext(entity, node);
        attachContext(node, entity, context);
    });
};

const forEachNode = (node: SemanticNode, visitor: (node: SemanticNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        forEachNode(child, visitor);
    }
};

const isWeakSemanticNode = (node: SemanticNode) => {
    const strongRoles = new Set(['input', 'button', 'link', 'checkbox', 'label', 'error']);
    return !strongRoles.has(node.role);
};

const findNearestEntity = (_node: SemanticNode, entities: SemanticNode[]) => {
    // 占位：后续补真正的最近实体定位。
    return entities[0];
};

const scanEntityContext = (_entity: SemanticNode, _node: SemanticNode) => {
    // 占位：后续补标题/label/列头/邻近文本扫描。
    return { labels: [] as string[] };
};

const attachContext = (_node: SemanticNode, _entity: SemanticNode, _context: { labels: string[] }) => {
    // 占位：后续把局部上下文语义挂回节点。
};
