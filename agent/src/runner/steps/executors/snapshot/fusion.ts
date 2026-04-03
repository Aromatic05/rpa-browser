import type { NodeGraph, UnifiedNode } from './types';
import { snapshotDebugLog } from './debug';

export const fuseDomAndA11y = (domTree: unknown, a11yTree: unknown): NodeGraph => {
    // 第一阶段最小实现：
    // 1) 以 DOM 为骨架
    // 2) 用 id 尝试注入 A11y role/name
    // 3) 对不上就跳过，不做复杂匹配
    const domRoot = asDomNode(domTree);
    if (!domRoot) {
        return {
            root: { id: 'n0', role: 'document', children: [] },
        };
    }

    const a11yRoot = asA11yNode(a11yTree);
    const a11yById = new Map<string, A11yNodeInput>();
    const a11yList: A11yNodeInput[] = [];
    walkA11y(a11yRoot, (node) => {
        if (node.id) a11yById.set(node.id, node);
        a11yList.push(node);
    });

    let fallbackCursor = 0;
    const usedA11yIndexes = new Set<number>();
    let matchedById = 0;
    let matchedByFallback = 0;
    let fallbackMiss = 0;
    let annotatedByA11yRole = 0;
    let keptDomRole = 0;
    const nextFallback = (node: DomNodeInput): A11yNodeInput | undefined => {
        if (!canUseFallback(node)) {
            fallbackMiss += 1;
            return undefined;
        }

        const windowEnd = Math.min(a11yList.length, fallbackCursor + FALLBACK_LOOKAHEAD);
        for (let index = fallbackCursor; index < windowEnd; index += 1) {
            if (usedA11yIndexes.has(index)) continue;
            const candidate = a11yList[index];
            if (!candidate) continue;
            if (isWeakA11yRole(candidate.role)) continue;
            if (!isRoleCompatible(node, candidate.role)) continue;

            usedA11yIndexes.add(index);
            fallbackCursor = Math.max(fallbackCursor, index + 1);
            matchedByFallback += 1;
            return candidate;
        }

        fallbackMiss += 1;
        return undefined;
    };

    const build = (node: DomNodeInput): UnifiedNode => {
        const matchedByNodeId = node.id ? a11yById.get(node.id) : undefined;
        if (matchedByNodeId) matchedById += 1;
        const matched = matchedByNodeId || nextFallback(node);
        const role = pickRole(node, matched);
        const domBaseRole = pickDomBaseRole(node);
        if (normalizeRole(role) !== normalizeRole(domBaseRole) && matched?.role) {
            annotatedByA11yRole += 1;
        } else {
            keptDomRole += 1;
        }

        return {
            id: node.id || `dom-${fallbackCursor}`,
            role,
            name: pickName(node, matched),
            text: node.text,
            bbox: node.bbox,
            attrs: node.attrs,
            children: (node.children || []).map((child) => build(child)),
        };
    };

    const graph = { root: build(domRoot) };
    snapshotDebugLog('fuse-map', {
        domRootId: domRoot.id || 'n0',
        a11yNodeCount: a11yList.length,
        matchedById,
        matchedByFallback,
        fallbackMiss,
        annotatedByA11yRole,
        keptDomRole,
    });
    return graph;
};

type DomNodeInput = {
    id?: string;
    tag?: string;
    text?: string;
    bbox?: { x: number; y: number; width: number; height: number };
    attrs?: Record<string, string>;
    children?: DomNodeInput[];
};

type A11yNodeInput = {
    id?: string;
    role?: string;
    name?: string;
    children?: A11yNodeInput[];
};

const asDomNode = (value: unknown): DomNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as DomNodeInput;
};

const asA11yNode = (value: unknown): A11yNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as A11yNodeInput;
};

const walkA11y = (node: A11yNodeInput | null, visitor: (node: A11yNodeInput) => void) => {
    if (!node) return;
    visitor(node);
    for (const child of node.children || []) {
        walkA11y(child, visitor);
    }
};

const pickRole = (node: DomNodeInput, matched: A11yNodeInput | undefined): string => {
    const domRole = pickDomBaseRole(node);
    const tag = normalizeRole(node.tag);
    if (tag && STRUCTURAL_TAGS.has(tag)) return tag;

    const a11yRole = normalizeRole(matched?.role);
    if (a11yRole && !isWeakA11yRole(a11yRole)) return a11yRole;

    return domRole;
};

const pickName = (node: DomNodeInput, matched: A11yNodeInput | undefined): string | undefined => {
    const a11yName = normalizeText(matched?.name);
    if (a11yName) return a11yName;

    const ariaLabel = normalizeText(node.attrs?.['aria-label']);
    if (ariaLabel) return ariaLabel;
    return undefined;
};

const normalizeRole = (value: string | undefined): string => (value || '').trim();

const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text ? text : undefined;
};

const pickDomBaseRole = (node: DomNodeInput): string => {
    const domRole = normalizeRole(node.attrs?.role);
    if (domRole) return domRole;

    const tag = normalizeRole(node.tag);
    if (tag) return tag;
    return 'generic';
};

const canUseFallback = (node: DomNodeInput): boolean => {
    const tag = normalizeRole(node.tag).toLowerCase();
    if (!tag) return false;
    if (INTERACTIVE_TAGS.has(tag)) return true;
    if (LANDMARK_TAGS.has(tag)) return true;
    if (ANNOTATABLE_CONTAINER_TAGS.has(tag)) return true;
    if (TEXTUAL_TAGS.has(tag)) return true;
    return false;
};

const isRoleCompatible = (node: DomNodeInput, role: string | undefined): boolean => {
    const normalizedRole = normalizeRole(role).toLowerCase();
    if (!normalizedRole) return false;

    const tag = normalizeRole(node.tag).toLowerCase();
    if (!tag) return false;

    if (INTERACTIVE_TAGS.has(tag)) {
        return INTERACTIVE_ROLES.has(normalizedRole);
    }

    if (tag === 'nav') return normalizedRole === 'navigation';
    if (tag === 'main') return normalizedRole === 'main';
    if (tag === 'header') return normalizedRole === 'banner';
    if (tag === 'footer') return normalizedRole === 'contentinfo';
    if (tag === 'aside') return normalizedRole === 'complementary';
    if (tag === 'section') return normalizedRole === 'region';
    if (tag === 'form') return normalizedRole === 'form';
    if (tag === 'ul' || tag === 'ol') return normalizedRole === 'list';
    if (tag === 'li') return normalizedRole === 'listitem';
    if (tag === 'table') return normalizedRole === 'table';
    if (tag === 'tr') return normalizedRole === 'row';
    if (tag === 'td' || tag === 'th') return normalizedRole === 'cell' || normalizedRole === 'columnheader' || normalizedRole === 'rowheader';
    if (TEXTUAL_TAGS.has(tag)) return TEXTUAL_ROLES.has(normalizedRole);
    if (ANNOTATABLE_CONTAINER_TAGS.has(tag)) return ANNOTATABLE_ROLES.has(normalizedRole);

    return false;
};

const isWeakA11yRole = (role: string | undefined): boolean => {
    const normalized = normalizeRole(role).toLowerCase();
    return WEAK_A11Y_ROLES.has(normalized);
};

const STRUCTURAL_TAGS = new Set(['html', 'head', 'body']);
const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'textarea', 'select', 'option', 'label']);
const LANDMARK_TAGS = new Set(['nav', 'main', 'header', 'footer', 'aside', 'section', 'form']);
const TEXTUAL_TAGS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const ANNOTATABLE_CONTAINER_TAGS = new Set(['div', 'span', 'article']);
const INTERACTIVE_ROLES = new Set([
    'link',
    'button',
    'textbox',
    'checkbox',
    'radio',
    'combobox',
    'option',
    'menuitem',
    'switch',
]);
const TEXTUAL_ROLES = new Set(['paragraph', 'heading', 'text']);
const ANNOTATABLE_ROLES = new Set([
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'article',
    'list',
    'listitem',
    'dialog',
    'table',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'img',
    'image',
    'heading',
    'paragraph',
]);
const WEAK_A11Y_ROLES = new Set(['none', 'generic', 'statictext', 'inlinetextbox', 'text']);
const FALLBACK_LOOKAHEAD = 24;
