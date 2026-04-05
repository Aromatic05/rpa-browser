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

        assignNodeContent(node, contentStore);
    });

    return {
        nodeIndex,
        bboxIndex,
        attrIndex,
        contentStore,
    };
};

const assignNodeContent = (node: UnifiedNode, contentStore: ContentStore) => {
    const content = normalizeText(getNodeContent(node));
    if (!content) {
        node.content = undefined;
        return;
    }

    if (content.length <= INLINE_CONTENT_MAX) {
        node.content = content;
        return;
    }

    const ref = `content_${node.id}`;
    contentStore[ref] = content;
    node.content = { ref };
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const INLINE_CONTENT_MAX = 80;
