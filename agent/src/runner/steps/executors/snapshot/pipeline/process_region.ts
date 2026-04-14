import { applyLCA } from '../stages/lca';
import { compress } from '../stages/compress';
import { finalizeLabel } from '../stages/finalize_label';
import { selectStructureCandidates } from '../stages/candidates';
import { buildStructureEntityIndex, detectStructureCandidates } from '../stages/entity_index';
import { isStrongSemanticRole } from '../core/interactive';
import type { EntityIndex, NodeTier, UnifiedNode } from '../core/types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const tree = stageBuildTree(node);
    const structure = stageSelectCandidates(tree);
    const entityIndex = stageBuildEntityIndex(tree, structure);

    stageMarkStrongSemantics(tree);
    stageApplyLCA(tree, entityIndex);
    stageRankTiers(tree);

    return stageCompressAndFinalize(tree);
};

const stageBuildTree = (node: UnifiedNode): UnifiedNode => node;

const stageSelectCandidates = (tree: UnifiedNode) => {
    const detected = detectStructureCandidates(tree);
    return selectStructureCandidates(tree, detected.candidates);
};

const stageBuildEntityIndex = (tree: UnifiedNode, structure: ReturnType<typeof stageSelectCandidates>) =>
    buildStructureEntityIndex(tree, structure, { includeDescendants: false });

const stageMarkStrongSemantics = (tree: UnifiedNode) => {
    walk(tree, (node) => {
        if (isStrongSemanticRole(node.role)) {
            node.tier = 'A';
        }
    });
};

const stageApplyLCA = (tree: UnifiedNode, entityIndex: EntityIndex) => {
    applyLCA(tree, entityIndex);
};

const stageRankTiers = (tree: UnifiedNode) => {
    walk(tree, (node) => {
        if (node.tier) return;
        node.tier = defaultTier(node);
    });
};

const stageCompressAndFinalize = (tree: UnifiedNode): UnifiedNode | null => {
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
