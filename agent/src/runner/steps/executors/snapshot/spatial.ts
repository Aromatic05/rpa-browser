import type { NodeGraph, UnifiedNode } from './types';

export const buildSpatialLayers = (graph: NodeGraph): NodeGraph => {
    // 这里不是独立 Layer 类型系统，只对 NodeGraph 顶层子树做重排/抽取。
    return {
        root: {
            ...graph.root,
            children: [...graph.root.children],
        },
    };
};

export const isNoiseLayer = (node: UnifiedNode): boolean => {
    // 轻量占位：后续再补低成本噪声判定。
    void node;
    return false;
};
