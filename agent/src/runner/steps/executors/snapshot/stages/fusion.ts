import type { NodeGraph, RuntimeStateMap, UnifiedNode } from '../core/types';
import { snapshotDebugLog } from '../core/debug';
import { setNodeAttrs, setNodeBbox, setNodeContent } from '../core/runtime_store';

export const fuseDomAndA11y = (
    domTree: unknown,
    a11yTree: unknown,
    runtimeStateMap: RuntimeStateMap | undefined = undefined,
): NodeGraph => {
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
    const consumedRuntimePathKeys = new Set<string>();

    const build = (node: DomNodeInput, parentPathKey?: string): UnifiedNode => {
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

        const pathKey = node.id || 'dom';
        const runtimeState = resolveRuntimeStateForNode(
            pathKey,
            node,
            parentPathKey,
            runtimeStateMap,
            consumedRuntimePathKeys,
        );
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
            id: pathKey,
            role,
            name,
            content,
            target,
            children: (node.children || []).map((child) => build(child, pathKey)),
        };
        setNodeAttrs(
            unified,
            mergeDomAttrs(
                node,
                validateRuntimeState(runtimeState, node, parentPathKey),
                matched,
            ),
        );
        setNodeBbox(unified, node.bbox);
        setNodeContent(unified, content);
        return unified;
    };

    const graph = { root: build(domRoot, undefined) };
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
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    pressed?: string;
    disabled?: string;
    readonly?: string;
    invalid?: string;
    focused?: string;
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

const mergeDomAttrs = (
    node: DomNodeInput,
    runtimeState: RuntimeStateMap[string] | undefined,
    matched: A11yNodeInput | undefined,
): Record<string, string> | undefined => {
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
    setAttr('value', resolveDynamicState(runtimeState?.value, matched?.value, node.attrs?.value));
    setAttr('checked', resolveDynamicState(runtimeState?.checked, normalizeA11yStateValue(matched?.checked), node.attrs?.checked));
    setAttr('selected', resolveDynamicState(runtimeState?.selected, normalizeA11yStateValue(matched?.selected), node.attrs?.selected));
    setAttr(
        'aria-checked',
        resolveDynamicState(runtimeState?.ariaChecked, normalizeA11yStateValue(matched?.checked), node.attrs?.['aria-checked']),
    );
    setAttr(
        'aria-selected',
        resolveDynamicState(runtimeState?.ariaSelected, normalizeA11yStateValue(matched?.selected), node.attrs?.['aria-selected']),
    );
    setAttr(
        'aria-expanded',
        resolveDynamicState(runtimeState?.ariaExpanded, normalizeA11yStateValue(matched?.expanded), node.attrs?.['aria-expanded']),
    );
    setAttr(
        'aria-pressed',
        resolveDynamicState(runtimeState?.ariaPressed, normalizeA11yStateValue(matched?.pressed), node.attrs?.['aria-pressed']),
    );
    setAttr('disabled', resolveDynamicState(runtimeState?.disabled, normalizeA11yStateValue(matched?.disabled), node.attrs?.disabled));
    setAttr('readonly', resolveDynamicState(runtimeState?.readonly, normalizeA11yStateValue(matched?.readonly), node.attrs?.readonly));
    setAttr(
        'aria-invalid',
        resolveDynamicState(runtimeState?.invalid, normalizeA11yStateValue(matched?.invalid), node.attrs?.['aria-invalid']),
    );
    setAttr('focused', resolveDynamicState(runtimeState?.focused, normalizeA11yStateValue(matched?.focused), node.attrs?.focused));

    if (Object.keys(next).length === 0) return undefined;
    return next;
};

const validateRuntimeState = (
    runtimeState: RuntimeStateMap[string] | undefined,
    node: DomNodeInput,
    _parentPathKey: string | undefined,
): RuntimeStateMap[string] | undefined => {
    if (!runtimeState) return undefined;

    const runtimeTag = normalizeRole(runtimeState.tag).toLowerCase();
    const domTag = normalizeRole(node.tag).toLowerCase();
    if (runtimeTag && domTag && runtimeTag !== domTag) return undefined;

    // Runtime state is indexed by the same DOM path key as fusion traversal.
    // For dynamic form controls (checkbox/radio/select), strict fingerprint checks
    // can reject true-positive matches when frameworks mutate wrappers/attrs.
    if (!isFingerprintCompatible(runtimeState.type, normalizeText(node.attrs?.type || node.type))) return undefined;
    if (!isFingerprintCompatible(runtimeState.idAttr, normalizeText(node.attrs?.id))) return undefined;
    if (!isFingerprintCompatible(runtimeState.nameAttr, normalizeText(node.attrs?.name))) return undefined;
    if (!isFingerprintCompatible(runtimeState.placeholder, normalizeText(node.attrs?.placeholder || node.placeholder))) {
        return undefined;
    }
    if (!isFingerprintCompatible(runtimeState.ariaLabel, normalizeText(node.attrs?.['aria-label']))) return undefined;
    if (
        !isFingerprintCompatible(
            runtimeState.dataTestId,
            normalizeText(node.attrs?.['data-testid'] || node.attrs?.['data-test-id']),
        )
    ) {
        return undefined;
    }

    return runtimeState;
};

const resolveRuntimeStateForNode = (
    pathKey: string,
    node: DomNodeInput,
    parentPathKey: string | undefined,
    runtimeStateMap: RuntimeStateMap | undefined,
    consumedPathKeys: Set<string>,
): RuntimeStateMap[string] | undefined => {
    if (!runtimeStateMap) return undefined;

    const exact = runtimeStateMap[pathKey];
    if (exact && validateRuntimeState(exact, node, parentPathKey)) {
        consumedPathKeys.add(pathKey);
        return exact;
    }

    let bestKey: string | undefined;
    let bestRow: RuntimeStateMap[string] | undefined;
    let bestScore = -1;
    let tie = false;

    for (const [candidateKey, row] of Object.entries(runtimeStateMap)) {
        if (consumedPathKeys.has(candidateKey)) continue;
        const score = scoreRuntimeCandidate(pathKey, candidateKey, node, row, parentPathKey);
        if (score <= 0) continue;
        if (score > bestScore) {
            bestScore = score;
            bestKey = candidateKey;
            bestRow = row;
            tie = false;
            continue;
        }
        if (score === bestScore) {
            tie = true;
        }
    }

    if (!bestKey || !bestRow || tie) return undefined;
    if (!validateRuntimeState(bestRow, node, parentPathKey)) return undefined;
    consumedPathKeys.add(bestKey);
    return bestRow;
};

const scoreRuntimeCandidate = (
    pathKey: string,
    candidatePathKey: string,
    node: DomNodeInput,
    runtimeState: RuntimeStateMap[string] | undefined,
    parentPathKey: string | undefined,
): number => {
    if (!runtimeState) return 0;
    let score = 0;
    if (!isFingerprintCompatible(runtimeState.idAttr, normalizeText(node.attrs?.id))) return 0;
    if (!isFingerprintCompatible(runtimeState.nameAttr, normalizeText(node.attrs?.name))) return 0;
    if (!isFingerprintCompatible(runtimeState.placeholder, normalizeText(node.attrs?.placeholder || node.placeholder))) return 0;
    if (!isFingerprintCompatible(runtimeState.ariaLabel, normalizeText(node.attrs?.['aria-label']))) return 0;
    if (
        !isFingerprintCompatible(
            runtimeState.dataTestId,
            normalizeText(node.attrs?.['data-testid'] || node.attrs?.['data-test-id']),
        )
    ) {
        return 0;
    }

    const nodeTag = normalizeRole(node.tag).toLowerCase();
    const rowTag = normalizeRole(runtimeState.tag).toLowerCase();
    if (nodeTag && rowTag && nodeTag !== rowTag) return 0;
    if (nodeTag && rowTag && nodeTag === rowTag) score += 4;

    const nodeType = normalizeText(node.attrs?.type || node.type);
    const rowType = normalizeText(runtimeState.type);
    if (nodeType && rowType) {
        if (nodeType !== rowType) return 0;
        score += 4;
    }

    score += normalizeText(runtimeState.idAttr) ? 3 : 0;
    score += normalizeText(runtimeState.nameAttr) ? 3 : 0;
    score += normalizeText(runtimeState.placeholder) ? 2 : 0;
    score += normalizeText(runtimeState.ariaLabel) ? 2 : 0;
    score += normalizeText(runtimeState.dataTestId) ? 2 : 0;
    if (isFingerprintCompatible(runtimeState.parentKey, parentPathKey)) {
        score += normalizeText(runtimeState.parentKey) ? 1 : 0;
    }

    const rowValue = normalizeText(runtimeState.value);
    const nodeValue = normalizeText(node.attrs?.value);
    if (rowValue && nodeValue) {
        if (rowValue !== nodeValue) return 0;
        score += 3;
    }

    const rowRole = normalizeText(runtimeState.role);
    const nodeRole = normalizeText(node.attrs?.role);
    if (rowRole && nodeRole) {
        if (rowRole !== nodeRole) return 0;
        score += 1;
    }

    score += scoreRuntimePathAffinity(pathKey, candidatePathKey);

    return score;
};

const scoreRuntimePathAffinity = (pathKey: string, candidatePathKey: string): number => {
    const a = splitPathKey(pathKey);
    const b = splitPathKey(candidatePathKey);
    if (a.length === 0 || b.length === 0) return 0;

    const shared = sharedPrefixLength(a, b);
    if (shared === 0) return 0;

    const sameParent = a.length > 1 && b.length > 1 && shared === a.length - 1 && shared === b.length - 1;
    if (sameParent) {
        const distance = Math.abs(readLastPathIndex(a) - readLastPathIndex(b));
        return Math.max(0, 6 - distance);
    }

    const depthGap = Math.abs(a.length - b.length);
    return Math.max(0, Math.min(4, shared) - depthGap);
};

const splitPathKey = (pathKey: string): string[] => {
    return pathKey
        .split('.')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
};

const sharedPrefixLength = (left: string[], right: string[]): number => {
    const len = Math.min(left.length, right.length);
    let matched = 0;
    for (let i = 0; i < len; i += 1) {
        if (left[i] !== right[i]) break;
        matched += 1;
    }
    return matched;
};

const readLastPathIndex = (parts: string[]): number => {
    const raw = parts[parts.length - 1] || '';
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
    return Number.MAX_SAFE_INTEGER;
};

const isFingerprintCompatible = (runtimeValue: string | undefined, domValue: string | undefined): boolean => {
    const runtimeText = normalizeText(runtimeValue);
    if (!runtimeText) return true;
    const domText = normalizeText(domValue);
    if (!domText) return false;
    return runtimeText === domText;
};

const resolveDynamicState = (
    runtimeValue: string | undefined,
    a11yValue: string | undefined,
    domValue: string | undefined,
): string | undefined => {
    const normalizedRuntime = normalizeText(runtimeValue);
    if (normalizedRuntime) return normalizedRuntime;
    const normalizedA11y = normalizeText(a11yValue);
    if (normalizedA11y) return normalizedA11y;
    return normalizeText(domValue);
};

const normalizeA11yStateValue = (value: string | undefined): string | undefined => {
    const normalized = normalizeRole(value).toLowerCase();
    if (!normalized) return undefined;
    if (normalized === 'mixed') return 'mixed';
    if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') return 'true';
    if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') return 'false';
    return normalized;
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
