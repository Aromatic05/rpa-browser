import type { UnifiedNode } from './types';

export const compress = (node: UnifiedNode): UnifiedNode | null => {
    // 第一阶段仅保留调用位与注释：
    // - D 类删除
    // - C 类壳层折叠
    // - 复杂低价值子树可摘要
    // 当前不实现真实压缩策略，直接返回原节点。
    return node;
};
