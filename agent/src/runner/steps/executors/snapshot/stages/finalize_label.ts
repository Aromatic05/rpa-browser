import {
    getNodeAttr,
    getNodeContent,
    getNodeSemanticHints,
    mergeNodeSemanticHints,
    normalizeText,
} from '../core/runtime_store';
import type { UnifiedNode } from '../core/types';

export const finalizeLabel = (tree: UnifiedNode): UnifiedNode => {
    const parentById = new Map<string, UnifiedNode | null>();
    buildParentIndex(tree, null, parentById);

    walk(tree, (node) => {
        relabelStructuralNode(node, parentById);
        if (isActionNode(node)) finalizeActionNode(node);
        if (isFieldNode(node)) finalizeFieldNode(node, parentById);
        if (isContainerNode(node)) finalizeContainerNode(node);
    });

    return tree;
};

const finalizeActionNode = (node: UnifiedNode) => {
    const text = pickActionText(node);
    if (text && !node.name) {
        node.name = text;
    }

    const hints = getNodeSemanticHints(node) || {};
    if (!hints.actionIntent) {
        mergeNodeSemanticHints(node, { actionIntent: inferActionIntent(node, text) });
    }
};

const finalizeFieldNode = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const hints = getNodeSemanticHints(node) || {};
    if (hints.fieldLabel) return;

    const explicit = pickExplicitFieldLabel(node);
    if (explicit) {
        mergeNodeSemanticHints(node, { fieldLabel: explicit });
        return;
    }

    const local = findLocalFieldLabel(node, parentById);
    if (local) {
        mergeNodeSemanticHints(node, { fieldLabel: local });
        if (!node.name) node.name = local;
    }
};

const finalizeContainerNode = (node: UnifiedNode) => {
    if (node.name) return;
    const title = findContainerTitle(node);
    if (title) {
        node.name = title;
    }
};

const relabelStructuralNode = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>) => {
    const role = normalizeRole(node.role);
    if (!WEAK_TEXT_CONTAINER_ROLES.has(role)) return;
    if (node.children.length > 0) return;

    const text = normalizeText(node.name || getNodeContent(node));
    if (!text || text.length > 24) return;

    const parent = parentById.get(node.id) || null;
    if (!parent) return;

    const parentRole = normalizeRole(parent.role);
    if (!RELABELED_PARENT_ROLES.has(parentRole)) return;

    const index = parent.children.findIndex((child) => child.id === node.id);
    if (index < 0) return;

    const hasNearbyList = parent.children.some((sibling, siblingIndex) => {
        if (siblingIndex === index) return false;
        if (Math.abs(siblingIndex - index) > 2) return false;
        const siblingRole = normalizeRole(sibling.role);
        return siblingRole === 'list';
    });
    if (!hasNearbyList) return;

    node.role = 'heading';
};

const buildParentIndex = (node: UnifiedNode, parent: UnifiedNode | null, parentById: Map<string, UnifiedNode | null>) => {
    parentById.set(node.id, parent);
    for (const child of node.children) {
        buildParentIndex(child, node, parentById);
    }
};

const walk = (node: UnifiedNode, visitor: (node: UnifiedNode) => void) => {
    visitor(node);
    for (const child of node.children) {
        walk(child, visitor);
    }
};

const findLocalFieldLabel = (node: UnifiedNode, parentById: Map<string, UnifiedNode | null>): string | undefined => {
    const parent = parentById.get(node.id) || null;
    if (!parent) return undefined;
    const index = parent.children.findIndex((child) => child.id === node.id);
    if (index <= 0) return undefined;
    for (let i = index - 1; i >= 0; i -= 1) {
        const text = firstReadableText(parent.children[i], 2);
        if (text) return text;
    }
    return undefined;
};

const findContainerTitle = (node: UnifiedNode): string | undefined => {
    for (const child of node.children) {
        if (!isLabelLikeNode(child)) continue;
        const text = normalizeText(child.name || getNodeContent(child));
        if (text) return text;
    }
    return undefined;
};

const firstReadableText = (node: UnifiedNode, depthLimit: number): string | undefined => {
    const queue: Array<{ node: UnifiedNode; depth: number }> = [{ node, depth: 0 }];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current) break;

        const own = normalizeText(current.node.name || getNodeContent(current.node));
        if (own && own.length <= 48 && !isActionNode(current.node)) {
            return own;
        }
        if (current.depth >= depthLimit) continue;
        for (const child of current.node.children) {
            queue.push({ node: child, depth: current.depth + 1 });
        }
    }
    return undefined;
};

const pickActionText = (node: UnifiedNode): string | undefined => {
    const candidates = [
        node.name,
        getNodeContent(node),
        getNodeAttr(node, 'aria-label'),
        getNodeAttr(node, 'title'),
        firstReadableText(node, 2),
    ]
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value));
    return candidates[0];
};

const pickExplicitFieldLabel = (node: UnifiedNode): string | undefined => {
    const candidates = [getNodeAttr(node, 'aria-label'), getNodeAttr(node, 'placeholder'), getNodeAttr(node, 'title')];
    for (const candidate of candidates) {
        const normalized = normalizeText(candidate);
        if (normalized) return normalized;
    }
    return undefined;
};

const inferActionIntent = (node: UnifiedNode, text: string | undefined): string | undefined => {
    const corpus = [text, getNodeAttr(node, 'aria-label'), getNodeAttr(node, 'title')]
        .map((value) => normalizeText(value))
        .filter((value): value is string => Boolean(value))
        .join(' ')
        .toLowerCase();

    for (const [intent, keywords] of ACTION_INTENT_KEYWORDS) {
        if (keywords.some((keyword) => corpus.includes(keyword))) return intent;
    }

    const role = normalizeRole(node.role);
    if (role === 'link') return 'open';
    if (role === 'button') return 'submit';
    return undefined;
};

const isActionNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return ACTION_ROLES.has(role) || ACTION_TAGS.has(tag);
};

const isFieldNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return FIELD_ROLES.has(role) || FIELD_TAGS.has(tag);
};

const isContainerNode = (node: UnifiedNode): boolean => {
    return CONTAINER_ROLES.has(normalizeRole(node.role));
};

const isLabelLikeNode = (node: UnifiedNode): boolean => {
    const role = normalizeRole(node.role);
    const tag = normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName'));
    return LABEL_ROLES.has(role) || tag === 'label';
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

const ACTION_ROLES = new Set(['button', 'link', 'menuitem']);
const ACTION_TAGS = new Set(['button', 'a']);
const FIELD_ROLES = new Set(['input', 'textarea', 'select', 'textbox', 'combobox', 'checkbox', 'radio']);
const FIELD_TAGS = new Set(['input', 'textarea', 'select']);
const CONTAINER_ROLES = new Set(['dialog', 'alertdialog', 'form', 'table', 'list', 'section', 'article', 'toolbar']);
const LABEL_ROLES = new Set(['label', 'heading', 'columnheader', 'rowheader']);
const WEAK_TEXT_CONTAINER_ROLES = new Set(['div', 'generic', 'group', 'section', 'article']);
const RELABELED_PARENT_ROLES = new Set(['contentinfo', 'navigation', 'complementary', 'region', 'section', 'article']);
const ACTION_INTENT_KEYWORDS: Array<[string, string[]]> = [
    ['search', ['search', 'find', '查询', '搜索']],
    ['filter', ['filter', '筛选']],
    ['delete', ['delete', 'remove', '删除', '移除']],
    ['edit', ['edit', 'update', '编辑', '修改']],
    ['create', ['create', 'new', 'add', '新增', '创建', '添加']],
    ['save', ['save', '保存']],
    ['close', ['close', 'cancel', '关闭', '取消']],
];
