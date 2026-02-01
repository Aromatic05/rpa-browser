/**
 * a11y hint 解析：从 A11y snapshot 中根据 role/name/text 查找 nodeId。
 */

import type { A11yHint } from '../types';

type A11ySnapshotNode = {
    id?: string;
    role?: string;
    name?: string;
    children?: A11ySnapshotNode[];
};

export const findA11yNodeId = (tree: A11ySnapshotNode, hint: A11yHint): string | null => {
    if (!tree) return null;
    const matches = (node: A11ySnapshotNode) => {
        if (hint.role && node.role !== hint.role) return false;
        if (hint.name && node.name !== hint.name) return false;
        if (hint.text && node.name !== hint.text) return false;
        return Boolean(node.id);
    };

    if (matches(tree)) return tree.id || null;
    for (const child of tree.children || []) {
        const found = findA11yNodeId(child, hint);
        if (found) return found;
    }
    return null;
};
