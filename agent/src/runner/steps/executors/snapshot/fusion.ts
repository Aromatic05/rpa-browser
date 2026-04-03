import type { NodeGraph, UnifiedNode } from './types';

export const fuseDomAndA11y = (domTree: unknown, a11yTree: unknown): NodeGraph => {
    // 第一阶段最小实现：
    // 1) 以 DOM 为骨架
    // 2) 用 id 尝试注入 A11y role/name
    // 3) 对不上就跳过，不做复杂匹配
    const domRoot = asDomNode(domTree);
    if (!domRoot) {
        return {
            root: { id: 'n0', role: 'document', children: [] },
        };
    }

    const a11yRoot = asA11yNode(a11yTree);
    const a11yById = new Map<string, A11yNodeInput>();
    const a11yList: A11yNodeInput[] = [];
    walkA11y(a11yRoot, (node) => {
        if (node.id) a11yById.set(node.id, node);
        a11yList.push(node);
    });

    let fallbackCursor = 0;
    const build = (node: DomNodeInput): UnifiedNode => {
        const fallbackA11y = a11yList[fallbackCursor];
        fallbackCursor += 1;
        const matched = (node.id && a11yById.get(node.id)) || fallbackA11y;

        return {
            id: node.id || `dom-${fallbackCursor}`,
            role: matched?.role || node.attrs?.role || node.tag || 'generic',
            name: matched?.name,
            text: node.text,
            bbox: node.bbox,
            attrs: node.attrs,
            children: (node.children || []).map((child) => build(child)),
        };
    };

    return { root: build(domRoot) };
};

type DomNodeInput = {
    id?: string;
    tag?: string;
    text?: string;
    bbox?: { x: number; y: number; width: number; height: number };
    attrs?: Record<string, string>;
    children?: DomNodeInput[];
};

type A11yNodeInput = {
    id?: string;
    role?: string;
    name?: string;
    children?: A11yNodeInput[];
};

const asDomNode = (value: unknown): DomNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as DomNodeInput;
};

const asA11yNode = (value: unknown): A11yNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as A11yNodeInput;
};

const walkA11y = (node: A11yNodeInput | null, visitor: (node: A11yNodeInput) => void) => {
    if (!node) return;
    visitor(node);
    for (const child of node.children || []) {
        walkA11y(child, visitor);
    }
};
