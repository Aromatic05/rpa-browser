import type {
    BBox,
    NodeSemanticHints,
    UnifiedNode,
} from '../../src/runner/steps/executors/snapshot/core/types';
import {
    mergeNodeSemanticHints,
    setNodeAttrs,
    setNodeBbox,
    setNodeContent,
} from '../../src/runner/steps/executors/snapshot/core/runtime_store';

type SnapshotNodePatch = Omit<Partial<UnifiedNode>, 'content'> & {
    attrs?: Record<string, string>;
    bbox?: BBox;
    content?: UnifiedNode['content'];
    semantic?: Partial<NodeSemanticHints>;
};

export const snapshotNode = (
    id: string,
    role: string,
    children: UnifiedNode[] = [],
    patch: SnapshotNodePatch = {},
): UnifiedNode => {
    const { attrs, bbox, content, semantic, ...nodePatch } = patch;
    const node: UnifiedNode = {
        id,
        role,
        children,
        ...nodePatch,
        ...(content && typeof content === 'object' ? { content: { ref: content.ref } } : {}),
    };
    setNodeAttrs(node, attrs);
    setNodeBbox(node, bbox);
    if (typeof content === 'string') {
        setNodeContent(node, content);
    }
    if (semantic) {
        mergeNodeSemanticHints(node, semantic);
    }
    return node;
};
