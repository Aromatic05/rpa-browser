import type { BBox, NodeSemanticHints, UnifiedNode } from './types';

type NodeRuntimeData = {
    attrs?: Record<string, string>;
    bbox?: BBox;
    content?: string;
    semantic?: NodeSemanticHints;
};

const runtimeStore = new WeakMap<UnifiedNode, NodeRuntimeData>();

const ensureRuntimeData = (node: UnifiedNode): NodeRuntimeData => {
    const current = runtimeStore.get(node);
    if (current) return current;
    const next: NodeRuntimeData = {};
    runtimeStore.set(node, next);
    return next;
};

export const setNodeAttrs = (node: UnifiedNode, attrs: Record<string, string> | undefined) => {
    if (!attrs || Object.keys(attrs).length === 0) return;
    ensureRuntimeData(node).attrs = { ...attrs };
};

export const getNodeAttrs = (node: UnifiedNode): Record<string, string> | undefined => {
    return runtimeStore.get(node)?.attrs;
};

export const getNodeAttr = (node: UnifiedNode, key: string): string | undefined => {
    return runtimeStore.get(node)?.attrs?.[key];
};

export const setNodeAttr = (node: UnifiedNode, key: string, value: string | undefined) => {
    const normalized = normalizeText(value);
    const data = ensureRuntimeData(node);
    if (!normalized) {
        if (!data.attrs) return;
        delete data.attrs[key];
        if (Object.keys(data.attrs).length === 0) {
            data.attrs = undefined;
        }
        return;
    }
    data.attrs = {
        ...(data.attrs || {}),
        [key]: normalized,
    };
};

export const setNodeBbox = (node: UnifiedNode, bbox: BBox | undefined) => {
    if (!bbox) return;
    ensureRuntimeData(node).bbox = { ...bbox };
};

export const getNodeBbox = (node: UnifiedNode): BBox | undefined => {
    return runtimeStore.get(node)?.bbox;
};

export const setNodeContent = (node: UnifiedNode, content: string | undefined) => {
    const normalized = normalizeText(content);
    if (!normalized) return;
    ensureRuntimeData(node).content = normalized;
};

export const getNodeContent = (node: UnifiedNode): string | undefined => {
    return runtimeStore.get(node)?.content;
};

export const mergeNodeSemanticHints = (node: UnifiedNode, patch: Partial<NodeSemanticHints>) => {
    const data = ensureRuntimeData(node);
    data.semantic = {
        ...(data.semantic || {}),
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    };
};

export const getNodeSemanticHints = (node: UnifiedNode): NodeSemanticHints | undefined => {
    return runtimeStore.get(node)?.semantic;
};

export const cloneTreeWithRuntime = (node: UnifiedNode): UnifiedNode => {
    const cloned: UnifiedNode = {
        id: node.id,
        role: node.role,
        name: node.name,
        content:
            typeof node.content === 'string'
                ? node.content
                : node.content?.ref
                  ? { ref: node.content.ref }
                  : undefined,
        target: node.target ? { ...node.target } : undefined,
        tier: node.tier,
        children: node.children.map((child) => cloneTreeWithRuntime(child)),
    };

    const runtime = runtimeStore.get(node);
    if (runtime) {
        runtimeStore.set(cloned, {
            attrs: runtime.attrs ? { ...runtime.attrs } : undefined,
            bbox: runtime.bbox ? { ...runtime.bbox } : undefined,
            content: runtime.content,
            semantic: runtime.semantic ? { ...runtime.semantic } : undefined,
        });
    }

    return cloned;
};

export const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
};
