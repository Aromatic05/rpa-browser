import type { UnifiedNode } from './types';

export const detectRegions = (node: UnifiedNode): UnifiedNode[] => {
    // 目标区域：form/table/list/card/dialog/nav/search/detail。
    // 当前占位：直接按普通子树返回，不引入 Region 类型系统。
    if (node.children.length > 0) {
        return node.children;
    }
    return [node];
};
