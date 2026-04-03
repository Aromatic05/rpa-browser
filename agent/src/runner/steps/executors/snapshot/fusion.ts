import type { NodeGraph, UnifiedNode } from './types';
import { snapshotDebugLog } from './debug';

export const fuseDomAndA11y = (domTree: unknown, a11yTree: unknown): NodeGraph => {
    // 第一阶段最小实现：
    // 1) 以 DOM 为骨架，保证结构稳定
    // 2) A11y 主要用于内容标注（role/name），不改变树结构
    // 3) 匹配不上时保守回退，不做激进推断
    const domRoot = asDomNode(domTree);
    if (!domRoot) {
        return {
            root: { id: 'n0', role: 'document', children: [] },
        };
    }

    const a11yRoot = asA11yNode(a11yTree);
    const a11yById = new Map<string, A11yNodeInput>();
    const a11yList: A11yNodeInput[] = [];
    const a11yRoleBuckets = new Map<string, IndexedA11yNode[]>();

    walkA11y(a11yRoot, (node) => {
        if (node.id) a11yById.set(node.id, node);
        a11yList.push(node);
        const index = a11yList.length - 1;
        const indexed: IndexedA11yNode = {
            index,
            node,
            role: normalizeRole(node.role).toLowerCase(),
            name: normalizeLabel(splitA11yName(normalizeText(node.name)).name),
        };
        const bucket = a11yRoleBuckets.get(indexed.role) || [];
        bucket.push(indexed);
        a11yRoleBuckets.set(indexed.role, bucket);
    });

    let fallbackCursor = 0;
    const usedA11yIndexes = new Set<number>();
    let matchedById = 0;
    let matchedByLabel = 0;
    let matchedByFallback = 0;
    let fallbackMiss = 0;
    let annotatedByA11yRole = 0;
    let keptDomRole = 0;
    let domNameFallback = 0;
    let downgradedA11yNameToContent = 0;
    let linkTargetExtracted = 0;

    const nextByRoleAndLabel = (node: DomNodeInput): A11yNodeInput | undefined => {
        const domRole = normalizeRole(pickDomBaseRole(node)).toLowerCase();
        const domLabel = normalizeLabel(inferDomMatchLabel(node, domRole));
        if (!domRole || !domLabel) return undefined;

        const bucket = a11yRoleBuckets.get(domRole);
        if (!bucket || bucket.length === 0) return undefined;

        const exact = findBestLabelMatch(bucket, domLabel, usedA11yIndexes, fallbackCursor, true);
        if (exact) {
            usedA11yIndexes.add(exact.index);
            fallbackCursor = Math.max(fallbackCursor, exact.index + 1);
            matchedByLabel += 1;
            return exact.node;
        }

        const fuzzy = findBestLabelMatch(bucket, domLabel, usedA11yIndexes, fallbackCursor, false);
        if (!fuzzy) return undefined;
        usedA11yIndexes.add(fuzzy.index);
        fallbackCursor = Math.max(fallbackCursor, fuzzy.index + 1);
        matchedByLabel += 1;
        return fuzzy.node;
    };

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

        const matchedByText = matchedByNodeId ? undefined : nextByRoleAndLabel(node);
        const matched =
            matchedByNodeId ||
            matchedByText ||
            (shouldBlockLooseFallback(node) ? undefined : nextFallback(node));

        const role = pickRole(node, matched);
        const domBaseRole = pickDomBaseRole(node);
        if (normalizeRole(role) !== normalizeRole(domBaseRole) && matched?.role) {
            annotatedByA11yRole += 1;
        } else {
            keptDomRole += 1;
        }

        const a11yNameParts = splitA11yName(normalizeText(matched?.name));
        if (a11yNameParts.content) {
            downgradedA11yNameToContent += 1;
        }

        const name = pickName(node, matched, role, a11yNameParts);
        if (name && !a11yNameParts.name) {
            domNameFallback += 1;
        }
        const content = pickContent(node, matched, role, name, a11yNameParts);
        const target = pickTarget(node, role);
        if (target) {
            linkTargetExtracted += 1;
        }

        return {
            id: node.id || `dom-${fallbackCursor}`,
            role,
            name,
            content,
            target,
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
        matchedByLabel,
        matchedByFallback,
        fallbackMiss,
        annotatedByA11yRole,
        keptDomRole,
        domNameFallback,
        downgradedA11yNameToContent,
        linkTargetExtracted,
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

type IndexedA11yNode = {
    index: number;
    node: A11yNodeInput;
    role: string;
    name: string;
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
    const domRole = normalizeRole(pickDomBaseRole(node));
    const tag = normalizeRole(node.tag).toLowerCase();
    if (tag && STRUCTURAL_TAGS.has(tag)) return tag;

    // 对语义稳定标签优先保留 DOM 语义，避免错配漂移。
    if (tag && DOM_STABLE_ROLE_TAGS.has(tag)) return domRole;

    const a11yRole = normalizeRole(matched?.role).toLowerCase();
    if (a11yRole && !isWeakA11yRole(a11yRole)) return a11yRole;

    return domRole;
};

const pickName = (
    node: DomNodeInput,
    matched: A11yNodeInput | undefined,
    role: string,
    a11yNameParts: { name?: string; content?: string },
): string | undefined => {
    const domLabel = inferExplicitDomName(node, normalizeRole(role).toLowerCase());
    const a11yName = a11yNameParts.name;
    const ariaLabel = pickExplicitDomLabel(node);
    const normalizedRole = normalizeRole(role).toLowerCase();

    if (a11yName && domLabel) {
        if (PREFER_A11Y_NAME_ROLES.has(normalizedRole)) return a11yName;
        return labelsSimilar(a11yName, domLabel) ? a11yName : domLabel;
    }
    if (a11yName) return a11yName;
    if (ariaLabel) return ariaLabel;
    if (domLabel) return domLabel;
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

    const tag = normalizeRole(node.tag).toLowerCase();
    if (!tag) return 'generic';

    const mapped = DOM_SEMANTIC_ROLE_BY_TAG.get(tag);
    if (mapped) return mapped;
    return tag;
};

const canUseFallback = (node: DomNodeInput): boolean => {
    const role = normalizeRole(pickDomBaseRole(node)).toLowerCase();
    if (!role) return false;
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (LANDMARK_ROLES.has(role)) return true;
    if (TEXTUAL_ROLES.has(role)) return true;
    if (ANNOTATABLE_ROLES.has(role)) return true;
    if (role === 'div' || role === 'span' || role === 'generic') return true;
    return false;
};

const shouldBlockLooseFallback = (node: DomNodeInput): boolean => {
    const role = normalizeRole(pickDomBaseRole(node)).toLowerCase();
    const domLabel = normalizeLabel(inferDomMatchLabel(node, role));
    if (!domLabel) return false;
    return INTERACTIVE_ROLES.has(role) || TEXTUAL_ROLES.has(role);
};

const isRoleCompatible = (node: DomNodeInput, role: string | undefined): boolean => {
    const normalizedRole = normalizeRole(role).toLowerCase();
    if (!normalizedRole) return false;

    const domRole = normalizeRole(pickDomBaseRole(node)).toLowerCase();
    if (!domRole) return false;

    if (INTERACTIVE_ROLES.has(domRole)) {
        return INTERACTIVE_ROLES.has(normalizedRole);
    }

    if (domRole === 'navigation') return normalizedRole === 'navigation';
    if (domRole === 'main') return normalizedRole === 'main';
    if (domRole === 'banner') return normalizedRole === 'banner';
    if (domRole === 'contentinfo') return normalizedRole === 'contentinfo';
    if (domRole === 'complementary') return normalizedRole === 'complementary';
    if (domRole === 'region') return normalizedRole === 'region';
    if (domRole === 'form') return normalizedRole === 'form';
    if (domRole === 'list') return normalizedRole === 'list';
    if (domRole === 'listitem') return normalizedRole === 'listitem';
    if (domRole === 'table') return normalizedRole === 'table';
    if (domRole === 'row') return normalizedRole === 'row';
    if (domRole === 'cell' || domRole === 'columnheader' || domRole === 'rowheader') {
        return normalizedRole === 'cell' || normalizedRole === 'columnheader' || normalizedRole === 'rowheader';
    }

    if (TEXTUAL_ROLES.has(domRole)) return TEXTUAL_ROLES.has(normalizedRole);

    if (domRole === 'div' || domRole === 'span' || domRole === 'generic') {
        return ANNOTATABLE_ROLES.has(normalizedRole);
    }

    if (ANNOTATABLE_ROLES.has(domRole)) {
        return ANNOTATABLE_ROLES.has(normalizedRole);
    }

    return false;
};

const isWeakA11yRole = (role: string | undefined): boolean => {
    const normalized = normalizeRole(role).toLowerCase();
    return WEAK_A11Y_ROLES.has(normalized);
};

const findBestLabelMatch = (
    bucket: IndexedA11yNode[],
    domLabel: string,
    used: Set<number>,
    cursor: number,
    exactOnly: boolean,
): IndexedA11yNode | undefined => {
    let best: IndexedA11yNode | undefined;
    let bestScore = Number.POSITIVE_INFINITY;

    for (const item of bucket) {
        if (used.has(item.index)) continue;
        if (!item.name) continue;

        const isExact = item.name === domLabel;
        const isFuzzy = !isExact && (item.name.includes(domLabel) || domLabel.includes(item.name));
        if (!isExact && (exactOnly || !isFuzzy)) continue;

        const score = item.index >= cursor ? item.index - cursor : 10_000 + (cursor - item.index);
        if (score < bestScore) {
            best = item;
            bestScore = score;
        }
    }

    return best;
};

const inferDomMatchLabel = (node: DomNodeInput, domRole: string): string | undefined => {
    // 匹配标签必须来源于显式命名候选，不能使用子树文本拼接。
    return inferExplicitDomName(node, domRole);
};

const pickExplicitDomLabel = (node: DomNodeInput): string | undefined => {
    const ariaLabel = normalizeText(node.attrs?.['aria-label']);
    if (ariaLabel) return ariaLabel;

    const title = normalizeText(node.attrs?.title);
    if (title) return title;

    const alt = normalizeText(node.attrs?.alt);
    if (alt) return alt;

    return undefined;
};

const inferExplicitDomName = (node: DomNodeInput, role: string): string | undefined => {
    const explicit = pickExplicitDomLabel(node);
    if (explicit) return explicit;

    const ownText = normalizeText(node.text);
    if (!ownText) return undefined;

    const tag = normalizeRole(node.tag).toLowerCase();
    if (NAME_FROM_OWN_TEXT_ROLES.has(role) || NAME_FROM_OWN_TEXT_TAGS.has(tag)) {
        if (isLikelyShortLabel(ownText)) return ownText;
    }
    return undefined;
};

const pickContent = (
    node: DomNodeInput,
    matched: A11yNodeInput | undefined,
    role: string,
    name: string | undefined,
    a11yNameParts: { name?: string; content?: string },
): string | undefined => {
    const ownText = normalizeText(node.text);
    if (ownText) return ownText;

    if (a11yNameParts.content) return a11yNameParts.content;

    const normalizedRole = normalizeRole(role).toLowerCase();
    if (CONTENT_BY_A11Y_NAME_ROLES.has(normalizedRole)) {
        return a11yNameParts.name || normalizeText(matched?.name);
    }

    if (normalizedRole === 'link') return a11yNameParts.name || name;
    return undefined;
};

const splitA11yName = (value: string | undefined): { name?: string; content?: string } => {
    const text = normalizeText(value);
    if (!text) return {};
    if (isLikelyShortLabel(text)) {
        return { name: text };
    }
    return { content: text };
};

const isLikelyShortLabel = (value: string): boolean => {
    const text = value.trim();
    if (!text) return false;

    const charCount = text.length;
    if (charCount > 72) return false;

    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount > 9) return false;

    const sentencePunctuation = (text.match(/[.!?。！？]/g) || []).length;
    if (sentencePunctuation >= 2) return false;

    const punctuationCount = (text.match(/[,:;，；、]/g) || []).length;
    if (punctuationCount >= 4) return false;

    if (/\b(and|or|but|because|which|that)\b/i.test(text) && wordCount >= 8) return false;
    return true;
};

const pickTarget = (
    node: DomNodeInput,
    role: string,
): UnifiedNode['target'] | undefined => {
    const tag = normalizeRole(node.tag).toLowerCase();
    const normalizedRole = normalizeRole(role).toLowerCase();
    if (normalizedRole !== 'link' && tag !== 'a') return undefined;

    const href = normalizeText(node.attrs?.href);
    if (!href) return undefined;

    return {
        ref: href,
        kind: classifyTargetKind(href, node),
    };
};

const classifyTargetKind = (ref: string, node: DomNodeInput): NonNullable<UnifiedNode['target']>['kind'] => {
    const lowered = ref.toLowerCase();
    if (lowered.startsWith('#')) return 'hash';
    if (lowered.startsWith('mailto:')) return 'mailto';
    if (lowered.startsWith('tel:')) return 'tel';
    if (lowered.startsWith('javascript:')) return 'javascript';

    const hasDownload = typeof node.attrs?.download === 'string';
    if (hasDownload) return 'download';

    if (lowered.startsWith('http://') || lowered.startsWith('https://') || lowered.startsWith('/')) return 'url';
    return 'unknown';
};

const normalizeLabel = (value: string | undefined): string => {
    return (value || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[\u200b-\u200d\ufeff]/g, '');
};

const labelsSimilar = (left: string, right: string): boolean => {
    const a = normalizeLabel(left);
    const b = normalizeLabel(right);
    if (!a || !b) return false;
    if (a === b) return true;
    return a.includes(b) || b.includes(a);
};

const STRUCTURAL_TAGS = new Set(['html', 'head', 'body']);
const DOM_STABLE_ROLE_TAGS = new Set([
    'a',
    'button',
    'input',
    'textarea',
    'select',
    'option',
    'label',
    'nav',
    'main',
    'header',
    'footer',
    'aside',
    'section',
    'form',
    'article',
    'ul',
    'ol',
    'li',
    'table',
    'tr',
    'td',
    'th',
    'p',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'img',
]);
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
const LANDMARK_ROLES = new Set(['navigation', 'main', 'banner', 'contentinfo', 'complementary', 'region', 'form']);
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
const FALLBACK_LOOKAHEAD = 32;
const PREFER_A11Y_NAME_ROLES = new Set([
    'navigation',
    'main',
    'banner',
    'contentinfo',
    'complementary',
    'region',
    'form',
    'article',
    'dialog',
    'list',
    'table',
]);
const NAME_FROM_OWN_TEXT_ROLES = new Set([
    'button',
    'link',
    'label',
    'option',
    'menuitem',
    'tab',
    'checkbox',
    'radio',
]);
const NAME_FROM_OWN_TEXT_TAGS = new Set(['button', 'a', 'label', 'option']);
const CONTENT_BY_A11Y_NAME_ROLES = new Set([
    'link',
    'button',
    'label',
    'option',
    'heading',
    'paragraph',
    'article',
    'listitem',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'text',
]);
const DOM_SEMANTIC_ROLE_BY_TAG = new Map<string, string>([
    ['a', 'link'],
    ['button', 'button'],
    ['input', 'textbox'],
    ['textarea', 'textbox'],
    ['select', 'combobox'],
    ['option', 'option'],
    ['label', 'label'],
    ['nav', 'navigation'],
    ['main', 'main'],
    ['header', 'banner'],
    ['footer', 'contentinfo'],
    ['aside', 'complementary'],
    ['section', 'region'],
    ['form', 'form'],
    ['article', 'article'],
    ['ul', 'list'],
    ['ol', 'list'],
    ['li', 'listitem'],
    ['table', 'table'],
    ['tr', 'row'],
    ['td', 'cell'],
    ['th', 'columnheader'],
    ['p', 'paragraph'],
    ['h1', 'heading'],
    ['h2', 'heading'],
    ['h3', 'heading'],
    ['h4', 'heading'],
    ['h5', 'heading'],
    ['h6', 'heading'],
    ['img', 'image'],
]);
