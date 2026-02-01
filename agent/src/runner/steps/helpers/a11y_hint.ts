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
    const normalize = (value?: string) => (value || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const hintName = normalize(hint.name);
    const hintText = normalize(hint.text);

    const matchNode = (node: A11ySnapshotNode, strictRole: boolean) => {
        if (strictRole && hint.role && node.role !== hint.role) return false;
        const nodeName = normalize(node.name);
        if (hintName && nodeName !== hintName && !nodeName.includes(hintName)) return false;
        if (hintText && nodeName !== hintText && !nodeName.includes(hintText)) return false;
        return Boolean(node.id);
    };

    const search = (root: A11ySnapshotNode, strictRole: boolean): string | null => {
        if (matchNode(root, strictRole)) return root.id || null;
        for (const child of root.children || []) {
            const found = search(child, strictRole);
            if (found) return found;
        }
        return null;
    };

    const strictFound = search(tree, true);
    if (strictFound) return strictFound;
    return search(tree, false);
};
