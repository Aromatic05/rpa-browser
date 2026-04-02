import type { UnifiedNode } from './types';

export const assignStableIds = (root: UnifiedNode) => {
    // 压缩后再生成稳定 ID，避免压缩前后身份漂移。
    walk(root, 'root');
};

const walk = (node: UnifiedNode, id: string) => {
    node.id = id;
    node.children.forEach((child, index) => {
        walk(child, `${id}.${index}`);
    });
};
