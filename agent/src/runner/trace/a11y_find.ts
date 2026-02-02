/**
 * a11y_find：根据 A11yHint 从缓存树中筛选候选节点。
 */

import type { A11yHint } from '../steps/types';
import type { A11ySnapshotNode } from './a11y_adopt';

export type A11yCandidate = {
    nodeId: string;
    role?: string;
    name?: string;
    preview: string;
};

const normalizeBase = (value?: string) =>
    (value || '')
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');

const normalizeRole = (value?: string) => normalizeBase(value);
const normalizeText = (value?: string) => normalizeBase(value);

const buildPreview = (node: A11ySnapshotNode) => {
    const raw = node.name || node.description || node.value || node.role || '';
    const trimmed = raw.trim().replace(/\s+/g, ' ');
    return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
};

const matchesNode = (node: A11ySnapshotNode, hint: A11yHint) => {
    if (hint.role && normalizeRole(node.role) !== normalizeRole(hint.role)) return false;
    if (hint.name) {
        const nodeName = normalizeText(node.name);
        if (!nodeName.includes(normalizeText(hint.name))) return false;
    }
    if (hint.text) {
        const text = normalizeText([node.name, node.description, node.value].filter(Boolean).join(' '));
        if (!text.includes(normalizeText(hint.text))) return false;
    }
    return Boolean(node.id);
};

export const findA11yCandidates = (tree: A11ySnapshotNode, hint: A11yHint): A11yCandidate[] => {
    const results: A11yCandidate[] = [];
    const walk = (node: A11ySnapshotNode) => {
        if (matchesNode(node, hint)) {
            results.push({
                nodeId: node.id,
                role: node.role,
                name: node.name,
                preview: buildPreview(node),
            });
        }
        for (const child of node.children || []) {
            walk(child);
        }
    };
    walk(tree);
    return results;
};
