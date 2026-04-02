import type { NodeGraph, UnifiedNode } from './types';

export const fuseDomAndA11y = (domTree: unknown, a11yTree: unknown): NodeGraph => {
    // 以 DOM 为骨架，把 A11y role/name/state 融合进统一节点图。
    // 当前仅做骨架占位：先产出最小可遍历图结构。
    void domTree;
    void a11yTree;

    const root: UnifiedNode = {
        id: 'root',
        role: 'document',
        children: [],
    };

    return { root };
};
