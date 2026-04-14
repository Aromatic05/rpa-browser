import type { NodeGraph, UnifiedNode } from '../core/types';
import { snapshotDebugLog } from '../core/debug';
import { setNodeAttrs, setNodeBbox, setNodeContent } from '../core/runtime_store';

export const fuseDomAndA11y = (domTree: unknown, a11yTree: unknown): NodeGraph => {
    const domRoot = asDomNode(domTree);
    if (!domRoot) {
        return {
            root: { id: 'n0', role: 'document', children: [] },
        };
    }

    const a11yRoot = asA11yNode(a11yTree);
    const a11yByBackendDomId = new Map<string, IndexedA11yNode[]>();
    let a11yNodeCount = 0;
    indexA11yTree(a11yRoot, a11yByBackendDomId, () => {
        a11yNodeCount += 1;
    });

    let matchedByBackendId = 0;
    let ambiguousBackendId = 0;
    let unmatchedNoBackendId = 0;
    let unmatchedNoA11y = 0;
    let annotatedByA11yRole = 0;
    let keptDomRole = 0;
    let linkTargetExtracted = 0;

    const build = (node: DomNodeInput): UnifiedNode => {
        const matchResult = matchByBackendDomId(node, a11yByBackendDomId);
        if (matchResult.type === 'matched') {
            matchedByBackendId += 1;
        } else if (matchResult.type === 'ambiguous') {
            ambiguousBackendId += 1;
        } else if (matchResult.type === 'no_backend') {
            unmatchedNoBackendId += 1;
        } else {
            unmatchedNoA11y += 1;
        }

        const matched = matchResult.type === 'matched' ? matchResult.node : undefined;
        const domBaseRole = pickDomBaseRole(node);
        const role = pickRole(node, matched);
        if (normalizeRole(role) !== normalizeRole(domBaseRole) && matched?.role) {
            annotatedByA11yRole += 1;
        } else {
            keptDomRole += 1;
        }

        const name = pickName(node, matched, role);
        const content = pickContent(node, matched, role, name);
        const target = pickTarget(node, role);
        if (target) {
            linkTargetExtracted += 1;
        }

        const unified: UnifiedNode = {
            id: node.id || 'dom',
            role,
            name,
            target,
            children: (node.children || []).map((child) => build(child)),
        };
        setNodeAttrs(unified, mergeDomAttrs(node));
        setNodeBbox(unified, node.bbox);
        setNodeContent(unified, content);
        return unified;
    };

    const graph = { root: build(domRoot) };
    snapshotDebugLog('fuse-map', {
        domRootId: domRoot.id || 'n0',
        a11yNodeCount,
        matchedByBackendId,
        ambiguousBackendId,
        unmatchedNoBackendId,
        unmatchedNoA11y,
        annotatedByA11yRole,
        keptDomRole,
        linkTargetExtracted,
    });
    return graph;
};

type DomNodeInput = {
    id?: string;
    tag?: string;
    text?: string;
    class?: string;
    href?: string;
    src?: string;
    title?: string;
    placeholder?: string;
    type?: string;
    bbox?: { x: number; y: number; width: number; height: number };
    backendDOMNodeId?: string;
    attrs?: Record<string, string>;
    children?: DomNodeInput[];
};

type A11yNodeInput = {
    id?: string;
    role?: string;
    name?: string;
    backendDOMNodeId?: string;
    children?: A11yNodeInput[];
};

type IndexedA11yNode = {
    node: A11yNodeInput;
    role: string;
};

type MatchByBackendResult =
    | { type: 'matched'; node: A11yNodeInput }
    | { type: 'ambiguous' }
    | { type: 'no_backend' }
    | { type: 'not_found' };

const asDomNode = (value: unknown): DomNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as DomNodeInput;
};

const asA11yNode = (value: unknown): A11yNodeInput | null => {
    if (!value || typeof value !== 'object') return null;
    return value as A11yNodeInput;
};

const indexA11yTree = (
    node: A11yNodeInput | null,
    a11yByBackendDomId: Map<string, IndexedA11yNode[]>,
    onEach: () => void,
) => {
    if (!node) return;

    onEach();
    const backendDomId = normalizeBackendDomId(node.backendDOMNodeId);
    if (backendDomId) {
        const bucket = a11yByBackendDomId.get(backendDomId) || [];
        bucket.push({
            node,
            role: normalizeRole(node.role).toLowerCase(),
        });
        a11yByBackendDomId.set(backendDomId, bucket);
    }

    for (const child of node.children || []) {
        indexA11yTree(child, a11yByBackendDomId, onEach);
    }
};

const matchByBackendDomId = (
    node: DomNodeInput,
    a11yByBackendDomId: Map<string, IndexedA11yNode[]>,
): MatchByBackendResult => {
    const backendDomId = normalizeBackendDomId(node.backendDOMNodeId || node.attrs?.backendDOMNodeId);
    if (!backendDomId) return { type: 'no_backend' };

    const bucket = a11yByBackendDomId.get(backendDomId) || [];
    if (bucket.length === 0) return { type: 'not_found' };

    const strong = bucket.filter((item) => !isWeakA11yRole(item.role));
    if (strong.length === 1) return { type: 'matched', node: strong[0].node };
    if (strong.length === 0) return { type: 'not_found' };
    // 严格模式：同一 backendDOMNodeId 出现多个强语义候选时直接判歧义，不做猜测消歧。
    return { type: 'ambiguous' };
};

const pickRole = (node: DomNodeInput, matched: A11yNodeInput | undefined): string => {
    const domRole = normalizeRole(pickDomBaseRole(node));
    const tag = normalizeRole(node.tag).toLowerCase();
    if (tag && STRUCTURAL_TAGS.has(tag)) return tag;

    // 稳定标签使用 DOM role，避免浏览器 a11y role 摇摆造成不必要抖动。
    if (tag && DOM_STABLE_ROLE_TAGS.has(tag)) return domRole;

    const a11yRole = normalizeRole(matched?.role).toLowerCase();
    if (a11yRole && !isWeakA11yRole(a11yRole)) return a11yRole;

    return domRole;
};

const pickName = (
    node: DomNodeInput,
    matched: A11yNodeInput | undefined,
    role: string,
): string | undefined => {
    const normalizedRole = normalizeRole(role).toLowerCase();
    const a11yNameParts = splitA11yName(normalizeText(matched?.name));
    if (a11yNameParts.name && A11Y_NAME_ALLOWED_ROLES.has(normalizedRole)) {
        return a11yNameParts.name;
    }

    const explicit = pickExplicitDomLabel(node);
    if (explicit) return explicit;

    const ownText = normalizeText(node.text);
    const tag = normalizeRole(node.tag).toLowerCase();
    if (!ownText) return undefined;
    if (NAME_FROM_OWN_TEXT_ROLES.has(normalizedRole) || NAME_FROM_OWN_TEXT_TAGS.has(tag)) {
        if (isLikelyShortLabel(ownText)) return ownText;
    }
    return undefined;
};

const pickContent = (
    node: DomNodeInput,
    matched: A11yNodeInput | undefined,
    role: string,
    name: string | undefined,
): string | undefined => {
    const ownText = normalizeText(node.text);
    if (ownText) return ownText;

    const a11yNameParts = splitA11yName(normalizeText(matched?.name));
    if (a11yNameParts.content) return a11yNameParts.content;

    const normalizedRole = normalizeRole(role).toLowerCase();
    if (CONTENT_BY_A11Y_NAME_ROLES.has(normalizedRole)) {
        return a11yNameParts.name || normalizeText(matched?.name);
    }
    if (normalizedRole === 'link') return a11yNameParts.name || name;
    return undefined;
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

const pickDomBaseRole = (node: DomNodeInput): string => {
    const domRole = normalizeRole(node.attrs?.role);
    if (domRole) return domRole;

    const tag = normalizeRole(node.tag).toLowerCase();
    if (!tag) return 'generic';

    if (tag === 'input') {
        const inputType = normalizeRole(node.attrs?.type || node.type).toLowerCase();
        const mappedInputRole = DOM_SEMANTIC_ROLE_BY_INPUT_TYPE.get(inputType);
        if (mappedInputRole) return mappedInputRole;
    }

    const mapped = DOM_SEMANTIC_ROLE_BY_TAG.get(tag);
    if (mapped) return mapped;
    return tag;
};

const isWeakA11yRole = (role: string | undefined): boolean => {
    const normalized = normalizeRole(role).toLowerCase();
    return WEAK_A11Y_ROLES.has(normalized);
};

const mergeDomAttrs = (node: DomNodeInput): Record<string, string> | undefined => {
    const next: Record<string, string> = {
        ...(node.attrs || {}),
    };

    const setAttr = (key: string, value: string | undefined) => {
        const normalized = normalizeText(value);
        if (!normalized) return;
        next[key] = normalized;
    };

    setAttr('tag', node.tag);
    setAttr('class', node.class);
    setAttr('href', node.href);
    setAttr('src', node.src);
    setAttr('title', node.title);
    setAttr('placeholder', node.placeholder);
    setAttr('type', node.type);
    setAttr('backendDOMNodeId', node.backendDOMNodeId);

    if (Object.keys(next).length === 0) return undefined;
    return next;
};

const splitA11yName = (value: string | undefined): { name?: string; content?: string } => {
    const text = normalizeText(value);
    if (!text) return {};
    if (isLikelyShortLabel(text)) {
        return { name: text };
    }
    return { content: text };
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

const normalizeRole = (value: string | undefined): string => (value || '').trim();

const normalizeText = (value: string | undefined): string | undefined => {
    const text = (value || '').trim();
    return text ? text : undefined;
};

const normalizeBackendDomId = (value: string | undefined): string | undefined => {
    const normalized = normalizeText(value);
    if (!normalized) return undefined;
    return /^\d+$/.test(normalized) ? normalized : undefined;
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
const WEAK_A11Y_ROLES = new Set(['none', 'generic', 'statictext', 'inlinetextbox', 'text']);
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
const A11Y_NAME_ALLOWED_ROLES = new Set([
    'link',
    'button',
    'label',
    'option',
    'menuitem',
    'tab',
    'checkbox',
    'radio',
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
    'listitem',
    'row',
    'cell',
    'columnheader',
    'rowheader',
    'heading',
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

const DOM_SEMANTIC_ROLE_BY_INPUT_TYPE = new Map<string, string>([
    ['checkbox', 'checkbox'],
    ['radio', 'radio'],
    ['search', 'searchbox'],
    ['number', 'spinbutton'],
    ['button', 'button'],
    ['submit', 'button'],
    ['reset', 'button'],
]);
