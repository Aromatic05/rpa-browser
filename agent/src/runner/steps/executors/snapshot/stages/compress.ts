import {
    getNodeAttr,
    getNodeContent,
    getNodeSemanticHints,
    mergeNodeSemanticHints,
    normalizeText,
    setNodeContent,
} from '../core/runtime_store';
import type { UnifiedNode } from '../core/types';

export const compress = (node: UnifiedNode): UnifiedNode | null => {
    activeNodeProfileCache = new WeakMap<UnifiedNode, NodeStaticProfile>();
    const result = compressNode(node, true, null);
    activeNodeProfileCache = null;
    if (result.nodes.length === 0) return null;
    return result.nodes[0] || null;
};

type CompressResult = {
    nodes: UnifiedNode[];
    liftedTexts: string[];
};

type NodeStaticProfile = {
    role: string;
    tag: string;
    className: string;
    hasOnclickAttr: boolean;
    hasHrefAttr: boolean;
    hasTabindexAttr: boolean;
};

let activeNodeProfileCache: WeakMap<UnifiedNode, NodeStaticProfile> | null = null;

const compressNode = (node: UnifiedNode, isRoot: boolean, parent: UnifiedNode | null): CompressResult => {
    const nextChildren: UnifiedNode[] = [];
    const liftedFromChildren: string[] = [];

    for (const child of node.children) {
        const childResult = compressNode(child, false, node);
        nextChildren.push(...childResult.nodes);
        liftedFromChildren.push(...childResult.liftedTexts);
    }
    node.children = nextChildren;

    if (shouldDropSubtree(node, isRoot)) {
        return { nodes: [], liftedTexts: [] };
    }

    if (isDeleteNode(node, isRoot)) {
        return {
            nodes: [],
            liftedTexts: compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]),
        };
    }

    if (isAtomicSemanticNode(node)) {
        truncateAtomicNode(node);
    }

    if (!isRoot && isCollapsibleShell(node, parent)) {
        const liftedTexts = compactLiftTexts([...liftedFromChildren, ...collectOwnLiftableTexts(node)]);
        if (node.children.length === 1 && hasSemanticPayload(node)) {
            mergeNodeSemanticHints(node.children[0], getNodeSemanticHints(node) || {});
        }
        return {
            nodes: node.children,
            liftedTexts,
        };
    }

    removeRedundantTextChildren(node);
    if (liftedFromChildren.length > 0 && canReceiveLiftedText(node)) {
        applyLiftedText(node, liftedFromChildren);
        return { nodes: [node], liftedTexts: [] };
    }

    return {
        nodes: [node],
        liftedTexts: compactLiftTexts(liftedFromChildren),
    };
};

const shouldDropSubtree = (node: UnifiedNode, isRoot: boolean): boolean => {
    const tag = nodeTag(node);
    const role = nodeRole(node);
    // head 分支必须强制裁掉，即使它正好是当前 region 根。
    if (FORCE_DROP_SUBTREE_TAGS.has(tag) || FORCE_DROP_SUBTREE_ROLES.has(role)) return true;

    if (isRoot) return false;
    if (isProtectedNode(node)) return false;

    if (DROP_SUBTREE_TAGS.has(tag) || DROP_SUBTREE_ROLES.has(role)) return true;
    if (VECTOR_SUBTREE_TAGS.has(tag) && !isMeaningfulImageNode(node)) return true;
    return false;
};

const isDeleteNode = (node: UnifiedNode, isRoot: boolean): boolean => {
    if (isRoot) return false;
    if (isProtectedNode(node)) return false;
    if (node.tier === 'D') return true;
    if (isPseudoNode(node)) return true;

    const tag = nodeTag(node);
    if (DELETE_TAGS.has(tag)) return true;
    if (isDecorativeNoise(node)) return true;
    if (isMeaninglessEmptyShell(node)) return true;
    return false;
};

const isCollapsibleShell = (node: UnifiedNode, parent: UnifiedNode | null): boolean => {
    if (isProtectedNode(node)) return false;
    if (!isWrapperRoleOrTag(node)) return false;
    if (node.children.length === 0) return false;

    const ownTexts = collectOwnLiftableTexts(node);
    if (ownTexts.length > 0 && !(parent && canReceiveLiftedText(parent))) return false;
    return true;
};

const isAtomicSemanticNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    if (!ATOMIC_ROLES.has(role) && !ATOMIC_TAGS.has(tag)) return false;
    if (node.name || getNodeContent(node) || node.target) return true;
    return isInteractiveNode(node);
};

const truncateAtomicNode = (node: UnifiedNode) => {
    const droppedTexts: Array<string | undefined> = [];
    for (const child of node.children) {
        collectDescendantLiftableTexts(child, droppedTexts);
    }
    node.children = [];
    if (droppedTexts.length > 0 && canReceiveLiftedText(node)) {
        applyLiftedText(node, compactLiftTexts(droppedTexts));
    }
};

const removeRedundantTextChildren = (node: UnifiedNode) => {
    const parentText = normalizeText(node.name || getNodeContent(node));
    const nextChildren: UnifiedNode[] = [];
    for (const child of node.children) {
        const childText = normalizeText(child.name || getNodeContent(child));
        if (!childText) {
            nextChildren.push(child);
            continue;
        }
        if (parentText && parentText === childText && isInlineTextShell(child)) {
            continue;
        }
        nextChildren.push(child);
    }
    node.children = nextChildren;
};

const applyLiftedText = (node: UnifiedNode, rawTexts: string[]) => {
    const candidates = compactLiftTexts(rawTexts);
    if (candidates.length === 0) return;
    const picked = candidates[0];
    if (!picked) return;

    if (!node.name && shouldAttachName(node)) {
        node.name = picked;
        return;
    }

    const current = normalizeText(getNodeContent(node));
    if (!current) {
        setNodeContent(node, picked);
        return;
    }
    if (current.includes(picked)) return;
    setNodeContent(node, `${current} ${picked}`.trim());
};

const shouldAttachName = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    return NAME_RECEIVER_ROLES.has(nodeRole(node));
};

const canReceiveLiftedText = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (hasSemanticPayload(node)) return true;
    return TEXT_RECEIVER_ROLES.has(nodeRole(node));
};

const hasSemanticPayload = (node: UnifiedNode): boolean => {
    const hints = getNodeSemanticHints(node);
    if (!hints) return false;
    return Boolean(hints.entityNodeId || hints.fieldLabel || hints.actionIntent || hints.actionTargetNodeId);
};

const isProtectedNode = (node: UnifiedNode): boolean => {
    if (isInteractiveNode(node)) return true;
    if (node.target) return true;
    if (hasSemanticPayload(node)) return true;
    if (PRESERVE_ROLES.has(nodeRole(node))) return true;
    if (isMeaningfulImageNode(node)) return true;
    return false;
};

const isInteractiveNode = (node: UnifiedNode): boolean => {
    const profile = getNodeStaticProfile(node);
    const role = profile.role;
    const tag = profile.tag;
    if (INTERACTIVE_ROLES.has(role) || INTERACTIVE_TAGS.has(tag)) return true;
    if (node.target) return true;
    if (profile.hasOnclickAttr || profile.hasHrefAttr || profile.hasTabindexAttr) return true;
    return false;
};

const isMeaningfulImageNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    if (role !== 'image' && role !== 'img' && tag !== 'img') return false;
    if (normalizeText(node.name) || normalizeText(getNodeContent(node))) return true;
    if (normalizeText(getNodeAttr(node, 'alt')) || normalizeText(getNodeAttr(node, 'src'))) return true;
    return false;
};

const isDecorativeNoise = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (node.name || getNodeContent(node)) return false;
    if (node.target) return false;

    const role = nodeRole(node);
    const tag = nodeTag(node);
    const cls = nodeClassName(node);
    if (DECORATIVE_ROLES.has(role) || DECORATIVE_TAGS.has(tag)) return true;
    if (cls && DECORATIVE_CLASS_PATTERN.test(cls)) return true;
    return false;
};

const isMeaninglessEmptyShell = (node: UnifiedNode): boolean => {
    if (node.children.length > 0) return false;
    if (node.name || getNodeContent(node)) return false;
    if (node.target) return false;
    return isWrapperRoleOrTag(node);
};

const isPseudoNode = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return PSEUDO_ROLES.has(role) || PSEUDO_TAGS.has(tag);
};

const isInlineTextShell = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return INLINE_TEXT_SHELL_ROLES.has(role) || INLINE_TEXT_SHELL_TAGS.has(tag);
};

const isWrapperRoleOrTag = (node: UnifiedNode): boolean => {
    const role = nodeRole(node);
    const tag = nodeTag(node);
    return WRAPPER_ROLES.has(role) || WRAPPER_TAGS.has(tag);
};

const collectOwnLiftableTexts = (node: UnifiedNode): string[] => {
    return compactLiftTexts([node.name, getNodeContent(node)]);
};

const collectDescendantLiftableTexts = (node: UnifiedNode, sink: Array<string | undefined>) => {
    sink.push(node.name, getNodeContent(node));
    for (const child of node.children) {
        collectDescendantLiftableTexts(child, sink);
    }
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
    if (value.length > 64) return false;
    const tokens = value.split(' ').filter((token) => token.length > 0);
    if (tokens.length > 10) return false;
    if (!HAS_TEXT_CHAR_PATTERN.test(value)) return false;
    return true;
};

const nodeRole = (node: UnifiedNode): string => getNodeStaticProfile(node).role;

const nodeTag = (node: UnifiedNode): string => getNodeStaticProfile(node).tag;

const nodeClassName = (node: UnifiedNode): string => getNodeStaticProfile(node).className;

const getNodeStaticProfile = (node: UnifiedNode): NodeStaticProfile => {
    if (!activeNodeProfileCache) {
        activeNodeProfileCache = new WeakMap<UnifiedNode, NodeStaticProfile>();
    }

    const cached = activeNodeProfileCache.get(node);
    if (cached) return cached;

    const profile: NodeStaticProfile = {
        role: normalizeRole(node.role),
        tag: normalizeRole(getNodeAttr(node, 'tag') || getNodeAttr(node, 'tagName') || getNodeAttr(node, 'nodeName')),
        className: normalizeRole(getNodeAttr(node, 'class')),
        hasOnclickAttr: Boolean(getNodeAttr(node, 'onclick')),
        hasHrefAttr: Boolean(getNodeAttr(node, 'href')),
        hasTabindexAttr: Boolean(getNodeAttr(node, 'tabindex')),
    };
    activeNodeProfileCache.set(node, profile);
    return profile;
};

const normalizeRole = (value: string | undefined): string => (value || '').trim().toLowerCase();

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
    'heading',
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
    'list',
    'toolbar',
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
const DROP_SUBTREE_TAGS = new Set(['meta', 'link', 'script', 'style', 'noscript', 'template', 'source', 'track']);
const FORCE_DROP_SUBTREE_TAGS = new Set(['head']);
const FORCE_DROP_SUBTREE_ROLES = new Set(['head']);
const DROP_SUBTREE_ROLES = new Set(['doc-subtitle', 'doc-tip', 'doc-endnote']);
const PSEUDO_ROLES = new Set(['::before', '::after', 'before', 'after']);
const PSEUDO_TAGS = new Set(['::before', '::after']);
const VECTOR_SUBTREE_TAGS = new Set(['svg', 'path', 'g', 'defs', 'symbol', 'use', 'clippath']);
const DECORATIVE_CLASS_PATTERN = /\b(icon|spinner|loading|skeleton|divider)\b/i;
const HAS_TEXT_CHAR_PATTERN = /[\p{L}\p{N}]/u;
