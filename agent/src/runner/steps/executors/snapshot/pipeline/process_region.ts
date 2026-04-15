import { applyLCA } from '../stages/lca';
import { compress } from '../stages/compress';
import { finalizeLabel } from '../stages/finalize_label';
import { selectStructureCandidates } from '../stages/candidates';
import { buildStructureEntityIndex, detectStructureCandidates } from '../stages/entity_index';
import { isStrongSemanticRole } from '../core/interactive';
import type { EntityIndex, NodeTier, UnifiedNode } from '../core/types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const tree = node;
    const detected = detectStructureCandidates(tree);
    const structure = selectStructureCandidates(tree, detected.candidates);
    const entityIndex = buildStructureEntityIndex(tree, structure, { includeDescendants: false });

    applyLCA(tree, entityIndex);

    walk(tree, (node) => {
        if (node.tier) return;
        if (isStrongSemanticRole(node.role)) {
            node.tier = 'A';
            return;
        }
        node.tier = defaultTier(node);
    });

    const compressed = compress(tree);
    if (!compressed) return null;
    return finalizeLabel(compressed);
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

const WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation', 'paragraph', 'text', 'div', 'span']);
const NOISE_ROLES = new Set(['none', 'presentation']);
