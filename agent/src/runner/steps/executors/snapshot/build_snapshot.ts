import type { SnapshotResult, UnifiedNode } from './types';

export const buildSnapshot = (root: UnifiedNode): SnapshotResult => {
    // 最小输出结构，后续再补格式化/摘要策略。
    return { root };
};
