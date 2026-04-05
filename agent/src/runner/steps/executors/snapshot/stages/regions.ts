import type { UnifiedNode } from '../core/types';

export const detectRegions = (node: UnifiedNode): UnifiedNode[] => {
    // 目标区域：form/table/list/card/dialog/nav/search/detail。
    // 当前占位：直接按普通子树返回，不引入 Region 类型系统。
    if (node.children.length > 0) {
        // 返回快照，避免上游边遍历边替换/删除 children 时跳过后续 region。
        return [...node.children];
    }
    return [node];
};
