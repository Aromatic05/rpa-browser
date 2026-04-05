import { applyLCA, type BusinessEntitySeed } from '../stages/lca';
import { compress } from '../stages/compress';
import { finalizeLabel } from '../stages/finalize_label';
import { getNodeAttr } from '../core/runtime_store';
import type { NodeTier, UnifiedNode } from '../core/types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const entities = detectBusinessEntities(node);
    const tree = buildTree(node);

    markStrongSemantics(tree);
    applyLCA(tree, entities);
    rankTiers(tree);

    return runCompressStage(tree);
};

const runCompressStage = (tree: UnifiedNode): UnifiedNode | null => {
    const compressed = compress(tree);
    if (!compressed) return null;
    return finalizeLabel(compressed);
};

const detectBusinessEntities = (node: UnifiedNode): BusinessEntitySeed[] => {
    const entities: BusinessEntitySeed[] = [];
    walk(node, (candidate) => {
        const kind = detectEntityKind(candidate);
        if (!kind) return;
        entities.push({
            nodeId: candidate.id,
            kind,
            name: candidate.name,
        });
    });
    return entities;
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

const detectEntityKind = (node: UnifiedNode): BusinessEntitySeed['kind'] | undefined => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    const cls = normalizeRole(getNodeAttr(node, 'class'));

    if (role === 'form' || tag === 'form') return 'form';
    if (role === 'table' || tag === 'table') return 'table';
    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'list' || tag === 'ul' || tag === 'ol') return 'list';
    if (role === 'toolbar' || cls.includes('toolbar')) return 'toolbar';
    if (role === 'section' || role === 'article' || cls.includes('panel') || cls.includes('card')) return 'panel';
    return undefined;
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
