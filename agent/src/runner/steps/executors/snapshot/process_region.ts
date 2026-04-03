import { applyLCA } from './lca';
import { compress } from './compress';
import type { NodeTier, UnifiedNode } from './types';

export const processRegion = (node: UnifiedNode): UnifiedNode | null => {
    const entities = detectBusinessEntities(node);
    const tree = buildTree(node);

    markStrongSemantics(tree);
    applyLCA(tree, entities);
    rankTiers(tree);

    const compressed = compress(tree);
    if (!compressed) return null;
    return compressed;
};

const detectBusinessEntities = (node: UnifiedNode): UnifiedNode[] => {
    // 第四阶段：识别结构并直接回写到 UnifiedNode 树。
    const entities: UnifiedNode[] = [];
    annotateTree(node, null, entities);
    return entities;
};

const buildTree = (node: UnifiedNode): UnifiedNode => {
    // 当前仍是 passthrough，结构语义已经直接写回 UnifiedNode。
    return node;
};

const markStrongSemantics = (tree: UnifiedNode) => {
    // 第四阶段：强语义节点提供 LCA 锚点。
    walk(tree, (node) => {
        const role = node.role.toLowerCase();
        if (STRONG_ROLES.has(role)) {
            patchNode(node, {
                tier: 'A',
                attrs: {
                    strongSemantic: 'true',
                },
            });
        }
    });
};

const rankTiers = (tree: UnifiedNode) => {
    // 节点价值分级仍保持轻量占位。
    walk(tree, (node) => {
        if (node.tier) return;
        node.tier = defaultTier(node);
    });
};

const defaultTier = (_node: UnifiedNode): NodeTier => 'B';

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const annotateTree = (node: UnifiedNode, parentEntityId: string | null, entities: UnifiedNode[]) => {
    annotateStructuralRoles(node);

    if (!node.fieldLabel && isFieldControl(node)) {
        const explicit = pickExplicitFieldLabel(node);
        if (explicit) {
            patchNode(node, {
                fieldLabel: explicit,
                attrs: { fieldLabel: explicit },
            });
        }
    }

    const entityType = detectEntityType(node);
    let currentEntityId = parentEntityId;
    if (entityType) {
        currentEntityId = `entity:${node.id}`;
        patchNode(node, {
            entityId: currentEntityId,
            entityType,
            parentEntityId: parentEntityId || undefined,
            attrs: {
                entity: 'true',
                entityId: currentEntityId,
                entityType,
                parentEntityId: parentEntityId || '',
            },
        });
        entities.push(node);
    } else if (parentEntityId) {
        patchNode(node, {
            parentEntityId,
            attrs: {
                parentEntityId,
            },
        });
    }

    for (const child of node.children) {
        annotateTree(child, currentEntityId, entities);
    }
};

const annotateStructuralRoles = (node: UnifiedNode) => {
    const tableRole = detectTableRole(node);
    if (tableRole) {
        patchNode(node, {
            tableRole,
            attrs: {
                tableRole,
            },
        });
    }

    const formRole = detectFormRole(node);
    if (formRole) {
        patchNode(node, {
            formRole,
            attrs: {
                formRole,
            },
        });
    }
};

const detectEntityType = (node: UnifiedNode): string | null => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);

    if (node.formRole === 'form') return 'form';
    if (node.formRole === 'field_group') return 'field_group';
    if (node.tableRole === 'table') return 'table';
    if (node.tableRole === 'row') return 'row';

    if (role === 'dialog' || role === 'alertdialog') return 'dialog';
    if (role === 'listitem' || tag === 'li') return 'list_item';
    if (role === 'section' || tag === 'section') return 'section';

    if (looksLikeCard(node)) return 'card';
    return null;
};

const detectTableRole = (node: UnifiedNode): UnifiedNode['tableRole'] | undefined => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);

    if (role === 'table' || role === 'grid' || tag === 'table') return 'table';
    if (role === 'row' || tag === 'tr') return 'row';
    if (role === 'columnheader' || role === 'rowheader' || tag === 'th') return 'header_cell';
    if (role === 'cell' || role === 'gridcell' || tag === 'td') return 'cell';
    return undefined;
};

const detectFormRole = (node: UnifiedNode): UnifiedNode['formRole'] | undefined => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);

    if (role === 'form' || tag === 'form') return 'form';
    if (isFieldControl(node)) return 'field';

    const fieldDescendants = countDescendants(node, isFieldControl);
    const actionDescendants = countDescendants(node, isActionControl);
    if (fieldDescendants >= 2) return 'field_group';
    if (fieldDescendants > 0 && actionDescendants > 0 && node.children.length > 1) return 'field_group';
    if (fieldDescendants === 0 && actionDescendants > 0 && role !== 'button') return 'submit_area';
    return undefined;
};

const countDescendants = (node: UnifiedNode, predicate: (node: UnifiedNode) => boolean): number => {
    let count = 0;
    for (const child of node.children) {
        if (predicate(child)) count += 1;
        count += countDescendants(child, predicate);
    }
    return count;
};

const isFieldControl = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
};

const isActionControl = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return ACTION_ROLES.has(role) || ACTION_TAGS.has(tag);
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const attrs = node.attrs || {};
    const candidates = [attrs['aria-label'], attrs.placeholder, attrs.title, attrs.label, attrs.name];
    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (normalized) return normalized;
    }
    return undefined;
};

const looksLikeCard = (node: UnifiedNode): boolean => {
    if (node.children.length < 3) return false;
    if (!hasTextSignal(node)) return false;
    if (!hasInteractiveDescendant(node)) return false;
    return true;
};

const hasTextSignal = (node: UnifiedNode): boolean => {
    const hasSelfText = (node.content || node.name || '').trim().length > 0;
    if (hasSelfText) return true;
    return node.children.some((child) => hasTextSignal(child));
};

const hasInteractiveDescendant = (node: UnifiedNode): boolean => {
    if (ACTION_ROLES.has(normalizeRole(node.role))) return true;
    if (node.attrs?.onclick || node.attrs?.href || node.attrs?.tabindex) return true;
    return node.children.some((child) => hasInteractiveDescendant(child));
};

const inferTag = (node: UnifiedNode): string => {
    const attrs = node.attrs || {};
    const raw = attrs.tag || attrs.tagName || attrs.nodeName || attrs.localName || attrs['data-tag'] || '';
    return normalizeRole(raw);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text.length > 0 ? text : undefined;
};

const patchNode = (node: UnifiedNode, patch: Partial<UnifiedNode> & { attrs?: Record<string, string> }) => {
    if (patch.attrs) {
        node.attrs = {
            ...(node.attrs || {}),
            ...Object.fromEntries(Object.entries(patch.attrs).filter(([, value]) => value !== '')),
        };
    }
    for (const [key, value] of Object.entries(patch)) {
        if (key === 'attrs') continue;
        if (value !== undefined) {
            (node as Record<string, unknown>)[key] = value;
        }
    }
};

const STRONG_ROLES = new Set(['button', 'textbox', 'checkbox', 'link']);
const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_TAGS = new Set(['button', 'a']);
