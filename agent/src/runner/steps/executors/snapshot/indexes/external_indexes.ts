import { getNodeAttrs, getNodeBbox, getNodeContent, normalizeText } from '../core/runtime_store';
import type { AttrIndex, BBoxIndex, ContentStore, NodeIndex, UnifiedNode } from '../core/types';

export type ExternalIndexes = {
    nodeIndex: NodeIndex;
    bboxIndex: BBoxIndex;
    attrIndex: AttrIndex;
    contentStore: ContentStore;
};

export const buildExternalIndexes = (root: UnifiedNode): ExternalIndexes => {
    const nodeIndex: NodeIndex = {};
    const bboxIndex: BBoxIndex = {};
    const attrIndex: AttrIndex = {};
    const contentStore: ContentStore = {};

    walk(root, (node) => {
        nodeIndex[node.id] = node;

        const bbox = getNodeBbox(node);
        if (bbox) {
            bboxIndex[node.id] = bbox;
        }

        const attrs = getNodeAttrs(node);
        if (attrs && Object.keys(attrs).length > 0) {
            attrIndex[node.id] = attrs;
        }

        assignContentRef(node, contentStore);
    });

    return {
        nodeIndex,
        bboxIndex,
        attrIndex,
        contentStore,
    };
};

const assignContentRef = (node: UnifiedNode, contentStore: ContentStore) => {
    const content = normalizeText(getNodeContent(node));
    if (!content) return;

    const normalizedName = normalizeText(node.name);
    if (!normalizedName && content.length <= 40) {
        node.name = content;
        node.contentRef = undefined;
        return;
    }

    if (normalizedName && normalizedName === content) {
        node.contentRef = undefined;
        return;
    }

    const ref = `content_${node.id}`;
    contentStore[ref] = content;
    node.contentRef = ref;
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};
