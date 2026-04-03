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

    if (!isRoot && isCollapsibleShell(node, parent)) {
        return {
            nodes: node.children,
            liftedTexts: compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]),
        };
    }

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

    const tag = inferTag(node);
    if (DELETE_TAGS.has(tag)) return true;
    if (isDecorativeNoise(node)) return true;
    if (isMeaninglessEmptyShell(node)) return true;
    return false;
};

const isCollapsibleShell = (node: UnifiedNode, parent: UnifiedNode | null): boolean => {
    if (isProtectedNode(node)) return false;
    if (hasCriticalState(node)) return false;

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
    }
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
    if (hasEntitySignals(node)) return true;
    if (hasLcaSignals(node)) return true;
    if (node.attrs?.strongSemantic === 'true') return true;
    if (hasCriticalState(node)) return true;

    const role = normalizeRole(node.role);
    if (PRESERVE_ROLES.has(role)) return true;
    return false;
};

const hasEntitySignals = (node: UnifiedNode): boolean => {
    if (node.entityId || node.entityType || node.parentEntityId) return true;
    if (node.tableRole || node.formRole) return true;
    return CRITICAL_ATTR_KEYS.some((key) => Boolean(node.attrs?.[key]));
};

const hasLcaSignals = (node: UnifiedNode): boolean => {
    if (node.fieldLabel || node.actionIntent || node.actionTargetId) return true;
    if (node.attrs?.fieldLabel || node.attrs?.actionIntent || node.attrs?.actionTargetId) return true;
    return false;
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

const hasOwnText = (node: UnifiedNode): boolean => {
    return Boolean(normalizeText(node.name) || normalizeText(node.content));
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
const CRITICAL_ATTR_KEYS = [
    'entityId',
    'entityType',
    'parentEntityId',
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
const URL_LIKE_PATTERN = /^(https?:\/\/|www\.)/i;
const HAS_TEXT_CHAR_PATTERN = /[\p{L}\p{N}]/u;
