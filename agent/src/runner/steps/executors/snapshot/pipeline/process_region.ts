import { applyLCA } from '../stages/lca';
import { compress } from '../stages/compress';
import { finalizeLabel } from '../stages/finalize_label';
import { selectStructureCandidates } from '../stages/candidates';
import { buildStructureEntityIndex, detectStructureCandidates } from '../stages/entity_index';
import type { NodeTier, UnifiedNode } from '../core/types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const tree = buildTree(node);
    const detected = detectStructureCandidates(tree);
    const structure = selectStructureCandidates(tree, detected.candidates);
    const entityIndex = buildStructureEntityIndex(tree, structure, { includeDescendants: false });

    markStrongSemantics(tree);
    applyLCA(tree, entityIndex);
    rankTiers(tree);

    return runCompressStage(tree);
};

const runCompressStage = (tree: UnifiedNode): UnifiedNode | null => {
    const compressed = compress(tree);
    if (!compressed) return null;
    return finalizeLabel(compressed);
};

const buildTree = (node: UnifiedNode): UnifiedNode => {
    return node;
};

const markStrongSemantics = (tree: UnifiedNode) => {
    walk(tree, (node) => {
        if (STRONG_ROLES.has(normalizeRole(node.role))) {
            node.tier = 'A';
        }
    });
};

const rankTiers = (tree: UnifiedNode) => {
    walk(tree, (node) => {
        if (node.tier) return;
        node.tier = defaultTier(node);
    });
};

const defaultTier = (node: UnifiedNode): NodeTier => {
    const role = normalizeRole(node.role);
    if (WRAPPER_ROLES.has(role) && !node.name && node.children.length > 0) {
        return 'C';
    }
    if (NOISE_ROLES.has(role) && !node.name && node.children.length === 0) {
        return 'D';
    }
    return 'B';
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const STRONG_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'combobox',
]);

const WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation', 'paragraph', 'text', 'div', 'span']);
const NOISE_ROLES = new Set(['none', 'presentation']);
