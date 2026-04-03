import type { UnifiedNode } from './types';

export const compress = (node: UnifiedNode): UnifiedNode | null => {
    const result = compressNode(node, true, null);
    if (result.nodes.length === 0) return null;
    return result.nodes[0] || null;
};

type CompressResult = {
    nodes: UnifiedNode[];
    liftedTexts: string[];
};

const compressNode = (
    node: UnifiedNode,
    isRoot: boolean,
    parent: UnifiedNode | null,
): CompressResult => {
    const nextChildren: UnifiedNode[] = [];
    const liftedFromChildren: string[] = [];

    for (const child of node.children) {
        const childResult = compressNode(child, false, node);
        nextChildren.push(...childResult.nodes);
        liftedFromChildren.push(...childResult.liftedTexts);
    }
    node.children = nextChildren;

    if (shouldDropSubtree(node, isRoot)) {
        return {
            nodes: [],
            liftedTexts: [],
        };
    }

    if (isDeleteNode(node, isRoot)) {
        return {
            nodes: [],
            liftedTexts: compactLiftTexts(liftedFromChildren),
        };
    }

    if (shouldSummarize(node)) {
        const summarized = summarize(node);
        if (liftedFromChildren.length > 0 && canReceiveLiftedText(summarized)) {
            applyLiftedText(summarized, liftedFromChildren);
            return { nodes: [summarized], liftedTexts: [] };
        }
        return {
            nodes: [summarized],
            liftedTexts: compactLiftTexts(liftedFromChildren),
        };
    }

    if (isAtomicSemanticNode(node)) {
        const truncated = truncateAtomicNode(node);
        if (liftedFromChildren.length > 0 && canReceiveLiftedText(truncated)) {
            applyLiftedText(truncated, liftedFromChildren);
        }
        return {
            nodes: [truncated],
            liftedTexts: [],
        };
    }

    if (!isRoot && isCollapsibleShell(node, parent)) {
        const liftedTexts = compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]);
        if (hasImportantSemanticPayload(node) && node.children.length === 1) {
            const receiver = node.children[0];
            absorbImportantSemantics(node, receiver);
            if (liftedTexts.length > 0 && canReceiveLiftedText(receiver)) {
                applyLiftedText(receiver, liftedTexts);
                return { nodes: [receiver], liftedTexts: [] };
            }
            return { nodes: [receiver], liftedTexts };
        }

        return {
            nodes: node.children,
            liftedTexts,
        };
    }

    removeRedundantTextChildren(node);
    dedupeImplementationChildren(node);

    if (liftedFromChildren.length === 0) {
        return {
            nodes: [node],
            liftedTexts: [],
        };
    }

    if (canReceiveLiftedText(node)) {
        applyLiftedText(node, liftedFromChildren);
        return {
            nodes: [node],
            liftedTexts: [],
        };
    }

    return {
        nodes: [node],
        liftedTexts: compactLiftTexts(liftedFromChildren),
    };
};

const isDeleteNode = (node: UnifiedNode, isRoot: boolean): boolean => {
    if (isRoot) return false;
    if (isProtectedNode(node)) return false;
    if (node.tier === 'D') return true;

    if (isPseudoNode(node)) return true;
    const tag = inferTag(node);
    if (DELETE_TAGS.has(tag)) return true;
    if (isSeparatorNoiseNode(node)) return true;
    if (isDecorativeNoise(node)) return true;
    if (isMeaninglessEmptyShell(node)) return true;
    return false;
};

const shouldDropSubtree = (node: UnifiedNode, isRoot: boolean): boolean => {
    if (isRoot) return false;
    if (isProtectedNode(node)) return false;

    const tag = inferTag(node);
    const role = normalizeRole(node.role);
    if (DROP_SUBTREE_TAGS.has(tag)) return true;
    if (DROP_SUBTREE_ROLES.has(role)) return true;

    // svg/shape 子树默认不进入最终语义树，除非该节点本身承载图片语义。
    if (VECTOR_SUBTREE_TAGS.has(tag) && !isMeaningfulImageNode(node)) return true;

    if (isDecorativeSubtree(node)) return true;
    return false;
};

const isCollapsibleShell = (node: UnifiedNode, parent: UnifiedNode | null): boolean => {
    if (isProtectedNode(node)) return false;
    if (hasCriticalState(node)) return false;
    if (isStructuralBoundary(node)) return false;
    if (hasImportantSemanticPayload(node) && node.children.length !== 1) return false;

    const ownTexts = collectOwnLiftableTexts(node);
    const textHeavy = hasOwnText(node) && ownTexts.length === 0;
    if (textHeavy) return false;

    // 叶子文本壳：仅在父节点能消费文本时折叠。
    if (
        node.children.length === 0 &&
        ownTexts.length > 0 &&
        parent &&
        canReceiveLiftedText(parent) &&
        isInlineTextShell(node)
    ) {
        return true;
    }

    // 常规壳层：有子节点且无关键语义时折叠并上提 children。
    if (node.tier === 'C' && node.children.length > 0) return true;
    if (node.children.length === 0) return false;
    if (!isWrapperRoleOrTag(node)) return false;
    if (node.target) return false;
    return true;
};

const isAtomicSemanticNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);

    const atomicByRole = ATOMIC_ROLES.has(role);
    const atomicByTag = ATOMIC_TAGS.has(tag);
    if (!atomicByRole && !atomicByTag) return false;

    // 没有语义负载时不强制原子化，避免把普通容器误截断。
    if (normalizeText(node.name) || normalizeText(node.content) || node.target) return true;
    if (isInteractiveNode(node)) return true;
    if (isMeaningfulImageNode(node)) return true;
    return false;
};

const truncateAtomicNode = (node: UnifiedNode): UnifiedNode => {
    const droppedTexts: string[] = [];
    const keptChildren: UnifiedNode[] = [];

    for (const child of node.children) {
        if (shouldKeepInsideAtomic(node, child)) {
            keptChildren.push(child);
            continue;
        }
        droppedTexts.push(...collectDescendantLiftableTexts(child));
    }

    node.children = keptChildren;
    if (droppedTexts.length > 0 && canReceiveLiftedText(node)) {
        applyLiftedText(node, droppedTexts);
    }
    return node;
};

const shouldKeepInsideAtomic = (parent: UnifiedNode, child: UnifiedNode): boolean => {
    if (isStructuralBoundary(child)) return true;
    if (isMeaningfulImageNode(child)) return true;
    if (hasHeavyText(child) && !normalizeText(parent.name || parent.content)) return true;

    // 原子节点内部仅保留真正独立的交互对象，避免把图标/装饰实现留下来。
    if (isInteractiveNode(child)) {
        if (!hasDistinctTarget(parent, child)) return false;
        if (!normalizeText(child.name) && !normalizeText(child.content)) return false;
        return true;
    }
    return false;
};

const hasHeavyText = (node: UnifiedNode): boolean => {
    const text = normalizeText(node.name || node.content);
    if (!text) return false;
    return !isLightweightText(text);
};

const hasDistinctTarget = (parent: UnifiedNode, child: UnifiedNode): boolean => {
    const parentTarget = normalizeText(parent.target?.ref);
    const childTarget = normalizeText(child.target?.ref);
    if (!childTarget) return false;
    if (!parentTarget) return true;
    return parentTarget !== childTarget;
};

const isPseudoNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return PSEUDO_ROLES.has(role) || PSEUDO_TAGS.has(tag);
};

const shouldSummarize = (node: UnifiedNode): boolean => {
    if (isProtectedNode(node)) return false;
    if (!isWrapperRoleOrTag(node)) return false;
    if (node.children.length < 120) return false;
    return countDescendants(node) > 240;
};

const summarize = (node: UnifiedNode): UnifiedNode => {
    const childCount = node.children.length;
    return {
        ...node,
        attrs: {
            ...(node.attrs || {}),
            summary: 'compressed',
            summaryChildren: String(childCount),
        },
        children: [],
    };
};

const applyLiftedText = (node: UnifiedNode, rawTexts: string[]) => {
    const candidates = compactLiftTexts(rawTexts);
    if (candidates.length === 0) return;

    const existing = compactLiftTexts([node.name, node.content]);
    const lifted = candidates.find((text) => !existing.includes(text));
    if (!lifted) return;

    if (!node.name && shouldAttachName(node)) {
        node.name = lifted;
    }
    if (!node.content) {
        node.content = lifted;
        return;
    }

    if (canMergeLiftedText(node)) {
        const merged = mergeText(node.content, lifted);
        if (merged) {
            node.content = merged;
        }
    }
};

const canMergeLiftedText = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return false;
    const role = normalizeRole(node.role);
    return MERGE_TEXT_ROLES.has(role);
};

const mergeText = (base: string, extra: string): string | undefined => {
    const left = normalizeText(base);
    const right = normalizeText(extra);
    if (!left || !right) return undefined;
    if (left.includes(right)) return left;
    const merged = `${left} ${right}`.trim();
    if (merged.length > 64) return undefined;
    return merged;
};

const shouldAttachName = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (hasEntitySignals(node)) return true;

    const role = normalizeRole(node.role);
    if (NAME_RECEIVER_ROLES.has(role)) return true;
    return false;
};

const canReceiveLiftedText = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (hasEntitySignals(node)) return true;
    if (hasLcaSignals(node)) return true;
    if (node.attrs?.strongSemantic === 'true') return true;

    const role = normalizeRole(node.role);
    if (TEXT_RECEIVER_ROLES.has(role)) return true;
    return false;
};

const isProtectedNode = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (node.target) return true;
    if (hasHardEntityBoundary(node)) return true;
    if (hasLcaSignals(node)) return true;
    if (node.attrs?.strongSemantic === 'true') return true;
    if (hasCriticalState(node)) return true;
    if (isStructuralBoundary(node)) return true;
    if (isMeaningfulImageNode(node)) return true;

    const role = normalizeRole(node.role);
    if (PRESERVE_ROLES.has(role)) return true;
    return false;
};

const hasEntitySignals = (node: UnifiedNode): boolean => {
    if (node.entityId || node.entityType) return true;
    if (node.tableRole || node.formRole) return true;
    return ENTITY_SIGNAL_ATTR_KEYS.some((key) => Boolean(node.attrs?.[key]));
};

const hasLcaSignals = (node: UnifiedNode): boolean => {
    if (node.fieldLabel || node.actionIntent || node.actionTargetId) return true;
    if (node.attrs?.fieldLabel || node.attrs?.actionIntent || node.attrs?.actionTargetId) return true;
    return false;
};

const hasHardEntityBoundary = (node: UnifiedNode): boolean => {
    const entityType = normalizeRole(node.entityType || node.attrs?.entityType);
    if (HARD_ENTITY_TYPES.has(entityType)) return true;

    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    if (HARD_FORM_ROLES.has(formRole)) return true;

    const tableRole = normalizeRole(node.tableRole || node.attrs?.tableRole);
    if (HARD_TABLE_ROLES.has(tableRole)) return true;
    return false;
};

const hasImportantSemanticPayload = (node: UnifiedNode): boolean => {
    if (node.entityId || node.entityType) return true;
    if (node.formRole || node.tableRole) return true;
    if (node.fieldLabel || node.actionIntent || node.actionTargetId) return true;
    return IMPORTANT_ATTR_KEYS.some((key) => Boolean(node.attrs?.[key]));
};

const absorbImportantSemantics = (source: UnifiedNode, target: UnifiedNode) => {
    if (!target.entityId && source.entityId) target.entityId = source.entityId;
    if (!target.entityType && source.entityType) target.entityType = source.entityType;
    if (!target.parentEntityId && source.parentEntityId) target.parentEntityId = source.parentEntityId;
    if (!target.formRole && source.formRole) target.formRole = source.formRole;
    if (!target.tableRole && source.tableRole) target.tableRole = source.tableRole;
    if (!target.fieldLabel && source.fieldLabel) target.fieldLabel = source.fieldLabel;
    if (!target.actionIntent && source.actionIntent) target.actionIntent = source.actionIntent;
    if (!target.actionTargetId && source.actionTargetId) target.actionTargetId = source.actionTargetId;

    const sourceAttrs = source.attrs || {};
    if (Object.keys(sourceAttrs).length === 0) return;
    target.attrs = {
        ...sourceAttrs,
        ...(target.attrs || {}),
    };
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (node.target) return true;
    if (node.attrs?.onclick || node.attrs?.href || node.attrs?.tabindex) return true;
    return false;
};

const isDecorativeNoise = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (hasOwnText(node)) return false;
    if (node.target) return false;

    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const classes = normalizeRole(node.attrs?.class);

    if (DECORATIVE_ROLES.has(role) || DECORATIVE_TAGS.has(tag)) return true;
    if (classes && DECORATIVE_CLASS_PATTERN.test(classes)) return true;
    return false;
};

const isDecorativeSubtree = (node: UnifiedNode): boolean => {
    if (isProtectedNode(node)) return false;
    if (hasOwnText(node)) return false;
    if (hasCriticalState(node)) return false;

    const classes = normalizeRole(node.attrs?.class);
    if (!classes || !DECORATIVE_CLASS_PATTERN.test(classes)) return false;

    if (containsInteractiveDescendant(node)) return false;
    if (containsStructuralBoundaryDescendant(node)) return false;
    return true;
};

const isSeparatorNoiseNode = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return false;
    if (node.children.length > 0) return false;
    if (node.target) return false;

    const classes = normalizeRole(node.attrs?.class);
    if (!classes || !SEPARATOR_CLASS_PATTERN.test(classes)) return false;

    const text = normalizeText(node.name || node.content || '');
    if (!text) return true;
    if (text.length > 3) return false;
    return SEPARATOR_TEXT_PATTERN.test(text);
};

const containsInteractiveDescendant = (node: UnifiedNode): boolean => {
    for (const child of node.children) {
        if (isInteractiveNode(child)) return true;
        if (containsInteractiveDescendant(child)) return true;
    }
    return false;
};

const containsStructuralBoundaryDescendant = (node: UnifiedNode): boolean => {
    for (const child of node.children) {
        if (isStructuralBoundary(child)) return true;
        if (containsStructuralBoundaryDescendant(child)) return true;
    }
    return false;
};

const isStructuralBoundary = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    if (STRUCTURE_BOUNDARY_ROLES.has(role)) return true;

    const entityType = normalizeRole(node.entityType || node.attrs?.entityType);
    if (HARD_ENTITY_TYPES.has(entityType)) return true;

    const formRole = normalizeRole(node.formRole || node.attrs?.formRole);
    if (HARD_FORM_ROLES.has(formRole)) return true;

    const tableRole = normalizeRole(node.tableRole || node.attrs?.tableRole);
    if (HARD_TABLE_ROLES.has(tableRole)) return true;
    return false;
};

const isMeaningfulImageNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const isImageRole = role === 'image' || role === 'img';
    const isImageTag = tag === 'img';
    if (!isImageRole && !isImageTag) return false;
    if (normalizeText(node.name) || normalizeText(node.content)) return true;
    if (normalizeText(node.attrs?.alt)) return true;
    if (normalizeText(node.attrs?.src)) return true;
    return false;
};

const isMeaninglessEmptyShell = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (hasOwnText(node)) return false;
    if (node.target) return false;
    if (!isWrapperRoleOrTag(node)) return false;
    return true;
};

const isInlineTextShell = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    return INLINE_TEXT_SHELL_ROLES.has(role) || INLINE_TEXT_SHELL_TAGS.has(tag);
};

const isWrapperRoleOrTag = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    if (WRAPPER_ROLES.has(role)) return true;
    if (WRAPPER_TAGS.has(tag)) return true;
    return false;
};

const hasCriticalState = (node: UnifiedNode): boolean => {
    for (const key of CRITICAL_STATE_KEYS) {
        const value = normalizeRole(node.attrs?.[key]);
        if (!value) continue;
        if (value === 'false' || value === '0' || value === 'off') continue;
        return true;
    }
    return false;
};

const collectOwnLiftableTexts = (node: UnifiedNode): string[] => {
    return compactLiftTexts([node.name, node.content]);
};

const collectDescendantLiftableTexts = (node: UnifiedNode): string[] => {
    const texts: string[] = [...collectOwnLiftableTexts(node)];
    for (const child of node.children) {
        texts.push(...collectDescendantLiftableTexts(child));
    }
    return compactLiftTexts(texts);
};

const hasOwnText = (node: UnifiedNode): boolean => {
    return Boolean(normalizeText(node.name) || normalizeText(node.content));
};

const removeRedundantTextChildren = (node: UnifiedNode) => {
    const parentText = normalizeText(node.name || node.content);
    const nextChildren: UnifiedNode[] = [];

    for (const child of node.children) {
        if (!isTextFragmentLike(child)) {
            nextChildren.push(child);
            continue;
        }
        const childText = normalizeText(child.name || child.content);
        if (!childText) {
            nextChildren.push(child);
            continue;
        }

        // 父节点已有稳定文本时，重复文本碎片直接回收删除。
        if (parentText && childText === parentText) {
            continue;
        }
        nextChildren.push(child);
    }

    node.children = nextChildren;
};

const isTextFragmentLike = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (isInteractiveNode(node)) return false;
    if (isStructuralBoundary(node)) return false;
    if (!isInlineTextShell(node)) return false;
    return Boolean(normalizeText(node.name || node.content));
};

const dedupeImplementationChildren = (node: UnifiedNode) => {
    const kept = new Set<string>();
    const nextChildren: UnifiedNode[] = [];

    for (const child of node.children) {
        const key = semanticKey(child);
        if (!key) {
            nextChildren.push(child);
            continue;
        }

        const dedupable = isDedupableImplementationNode(child);
        if (!dedupable) {
            nextChildren.push(child);
            continue;
        }
        if (kept.has(key)) continue;

        kept.add(key);
        nextChildren.push(child);
    }

    node.children = nextChildren;
};

const isDedupableImplementationNode = (node: UnifiedNode): boolean => {
    if (isStructuralBoundary(node)) return false;
    if (isInteractiveNode(node)) return false;
    if (hasHardEntityBoundary(node)) return false;
    if (hasCriticalState(node)) return false;

    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    if (isInlineTextShell(node)) return true;
    if (WRAPPER_ROLES.has(role) || WRAPPER_TAGS.has(tag)) return true;
    if (DECORATIVE_ROLES.has(role) || DECORATIVE_TAGS.has(tag)) return true;
    if (VECTOR_SUBTREE_TAGS.has(tag)) return true;
    return false;
};

const semanticKey = (node: UnifiedNode): string | null => {
    const role = normalizeRole(node.role);
    const tag = inferTag(node);
    const text = normalizeText(node.name || node.content || '') || '';
    const ref = normalizeText(node.target?.ref) || '';
    const cls = normalizeText(node.attrs?.class) || '';
    const key = `${role}|${tag}|${text}|${ref}|${cls}`;
    if (!role && !tag && !text && !ref && !cls) return null;
    return key;
};

const compactLiftTexts = (values: Array<string | undefined>): string[] => {
    const dedup = new Set<string>();
    for (const value of values) {
        const normalized = normalizeText(value);
        if (!normalized) continue;
        if (!isLightweightText(normalized)) continue;
        dedup.add(normalized);
    }
    return [...dedup];
};

const isLightweightText = (value: string): boolean => {
    if (value.length > 32) return false;
    const tokens = value.split(' ').filter((token) => token.length > 0);
    if (tokens.length > 8) return false;
    if (URL_LIKE_PATTERN.test(value)) return false;
    if (!HAS_TEXT_CHAR_PATTERN.test(value)) return false;
    return true;
};

const countDescendants = (node: UnifiedNode): number => {
    let count = 0;
    for (const child of node.children) {
        count += 1 + countDescendants(child);
    }
    return count;
};

const inferTag = (node: UnifiedNode): string => {
    const attrs = node.attrs || {};
    const raw = attrs.tag || attrs.tagName || attrs.nodeName || attrs.localName || attrs['data-tag'] || '';
    return normalizeRole(raw);
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();
const normalizeText = (value: string | undefined): string | undefined => {
    const normalized = (value || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : undefined;
};

const DELETE_TAGS = new Set(['script', 'style', 'svg', 'path']);
const DECORATIVE_TAGS = new Set(['i']);
const DECORATIVE_ROLES = new Set(['none', 'presentation']);
const WRAPPER_ROLES = new Set(['generic', 'group', 'none', 'presentation', 'text', 'paragraph', 'div', 'span']);
const WRAPPER_TAGS = new Set(['div', 'span', 'p']);
const INLINE_TEXT_SHELL_ROLES = new Set(['generic', 'text', 'paragraph', 'span', 'div']);
const INLINE_TEXT_SHELL_TAGS = new Set(['span', 'strong', 'em', 'b', 'i']);
const INTERACTIVE_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'input',
    'textarea',
    'select',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'menuitem',
    'option',
    'tab',
]);
const INTERACTIVE_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select', 'option']);
const ATOMIC_ROLES = new Set([
    'button',
    'link',
    'textbox',
    'checkbox',
    'radio',
    'switch',
    'combobox',
    'menuitem',
    'tab',
    'image',
    'img',
]);
const ATOMIC_TAGS = new Set(['button', 'a', 'input', 'textarea', 'select', 'img']);
const PRESERVE_ROLES = new Set([
    'root',
    'html',
    'body',
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'dialog',
    'alertdialog',
    'table',
    'row',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'list',
    'listitem',
]);
const STRUCTURE_BOUNDARY_ROLES = new Set([
    'root',
    'html',
    'body',
    'main',
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'section',
    'article',
    'list',
    'listitem',
    'table',
    'row',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'form',
    'dialog',
    'alertdialog',
]);
const HARD_ENTITY_TYPES = new Set(['form', 'field_group', 'table', 'row', 'card', 'dialog', 'list_item', 'section']);
const HARD_FORM_ROLES = new Set(['form', 'field_group']);
const HARD_TABLE_ROLES = new Set(['table', 'row', 'header_cell', 'cell']);
const NAME_RECEIVER_ROLES = new Set(['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option']);
const TEXT_RECEIVER_ROLES = new Set([
    ...NAME_RECEIVER_ROLES,
    'heading',
    'label',
    'cell',
    'gridcell',
    'columnheader',
    'rowheader',
    'dialog',
]);
const MERGE_TEXT_ROLES = new Set(['heading', 'label', 'cell', 'gridcell', 'columnheader', 'rowheader', 'paragraph']);
const DROP_SUBTREE_TAGS = new Set([
    'head',
    'meta',
    'link',
    'script',
    'style',
    'noscript',
    'template',
    'source',
    'track',
]);
const DROP_SUBTREE_ROLES = new Set(['head', 'doc-subtitle', 'doc-tip', 'doc-endnote']);
const PSEUDO_ROLES = new Set(['::before', '::after', 'before', 'after']);
const PSEUDO_TAGS = new Set(['::before', '::after']);
const VECTOR_SUBTREE_TAGS = new Set(['svg', 'path', 'g', 'defs', 'symbol', 'use', 'clipPath'.toLowerCase()]);
const IMPORTANT_ATTR_KEYS = [
    'entityId',
    'entityType',
    'tableRole',
    'formRole',
    'fieldLabel',
    'actionIntent',
    'actionTargetId',
    'rowIndex',
    'columnIndex',
    'columnId',
    'rowId',
    'tableSection',
    'strongSemantic',
    'labelFor',
] as const;
const ENTITY_SIGNAL_ATTR_KEYS = [
    'entityId',
    'entityType',
    'tableRole',
    'formRole',
    'fieldLabel',
    'actionIntent',
    'actionTargetId',
    'rowIndex',
    'columnIndex',
    'columnId',
    'rowId',
    'tableSection',
] as const;
const CRITICAL_STATE_KEYS = [
    'aria-expanded',
    'expanded',
    'aria-selected',
    'selected',
    'aria-checked',
    'checked',
    'aria-pressed',
    'pressed',
    'aria-disabled',
    'disabled',
    'required',
    'readonly',
    'invalid',
] as const;
const DECORATIVE_CLASS_PATTERN = /\b(icon|spinner|loading|skeleton|divider)\b/i;
const SEPARATOR_CLASS_PATTERN = /\b(separator|breadcrumb-separator)\b/i;
const SEPARATOR_TEXT_PATTERN = /^[\/|>»›·•-]+$/;
const URL_LIKE_PATTERN = /^(https?:\/\/|www\.)/i;
const HAS_TEXT_CHAR_PATTERN = /[\p{L}\p{N}]/u;
