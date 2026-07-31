import type {
    PickAncestorFingerprint,
    PickFingerprint,
    PickPoint,
    PickRect,
} from '../types.js';

export type DOMElFingerprint = {
    tagName: string;
    classTokens: string[];
    role?: string;
    text?: string;
    ariaLabel?: string;
    rect: PickRect;
};

export type HitTestInput = {
    point: PickPoint;
    elements: DOMElFingerprint[];
    ancestors: DOMElFingerprint[];
};

const PICKER_HOST_IDS = new Set(['rpa-floating-panel', 'rpa-entity-annotator-host']);
const PANEL_ATTR = 'data-rpa-panel';
const ANNOTATOR_HOST_ATTR = 'data-rpa-annotator-host';

type ClosestLike = {
    closest?: (selector: string) => Element | null;
};

const readAttr = (node: unknown, name: string): string | null => {
    if (typeof node !== 'object' || node === null) {return null;}
    const getter = (node as {getAttribute?: (n: string) => string | null}).getAttribute;
    if (typeof getter === 'function') {
        try {
            const value = getter.call(node, name);
            return typeof value === 'string' ? value : null;
        } catch {
            return null;
        }
    }
    return null;
};

const readId = (node: unknown): string => {
    if (typeof node !== 'object' || node === null) {return '';}
    const id = (node as {id?: unknown}).id;
    return typeof id === 'string' ? id : '';
};

export const isPickerHost = (element: unknown): boolean => {
    if (element === null || element === undefined) {return false;}
    const closestLike = element as ClosestLike;
    if (typeof closestLike.closest === 'function') {
        try {
            const matched = closestLike.closest.call(
                element,
                `[${PANEL_ATTR}="true"], [${ANNOTATOR_HOST_ATTR}="true"]`,
            );
            if (matched) {return true;}
        } catch {
            // closest may throw on bad selector in unusual environments; fall through.
        }
    }
    let cursor: unknown = element;
    let depth = 0;
    while (cursor !== null && cursor !== undefined && depth < 64) {
        const id = readId(cursor);
        if (id && PICKER_HOST_IDS.has(id)) {return true;}
        if (readAttr(cursor, PANEL_ATTR) === 'true') {return true;}
        if (readAttr(cursor, ANNOTATOR_HOST_ATTR) === 'true') {return true;}
        cursor = (cursor as {parentNode?: unknown}).parentNode;
        depth += 1;
    }
    return false;
};

export const shouldInterceptClick = (target: unknown): boolean => {
    if (target === null || target === undefined) {return false;}
    return !isPickerHost(target);
};

const looksStable = (token: string): boolean =>
    token.length >= 3 &&
    token.length <= 28 &&
    !/^\d/.test(token) &&
    !/^(css|sc|rc|chakra|emotion|styled|jsx|next)-/i.test(token) &&
    !/^[a-z0-9]+$/i.test(token) &&
    !/-\d{3,}/.test(token);

const pickStableClass = (tokens: string[]): string | null => {
    for (const token of tokens) {
        if (looksStable(token)) {return token;}
    }
    return null;
};

const buildSelectorCandidates = (
    primary: DOMElFingerprint,
    ancestors: DOMElFingerprint[],
): string[] => {
    const out: string[] = [];
    const tag = primary.tagName.toLowerCase();
    out.push(tag);
    const stableClass = pickStableClass(primary.classTokens);
    if (stableClass) {
        out.push(`${tag}.${stableClass}`);
    }
    for (const ancestor of ancestors.slice(0, 2)) {
        const ancestorTag = ancestor.tagName.toLowerCase();
        if (ancestorTag) {
            out.push(`${ancestorTag} ${tag}`);
        }
    }
    return out;
};

const toAncestorFingerprint = (
    source: DOMElFingerprint,
): PickAncestorFingerprint => ({
    tagName: source.tagName,
    classTokens: source.classTokens,
    role: source.role,
    text: source.text,
    ariaLabel: source.ariaLabel,
    rect: source.rect,
});

export const buildFingerprintFromHitTest = (hit: HitTestInput): PickFingerprint => {
    const primary = hit.elements[0];
    const fallbackRect: PickRect = {x: 0, y: 0, width: 0, height: 0};
    if (!primary) {
        return {
            point: hit.point,
            selectorCandidates: [],
            tagName: '',
            classTokens: [],
            rect: fallbackRect,
            ancestors: hit.ancestors.map(toAncestorFingerprint),
        };
    }
    return {
        point: hit.point,
        selectorCandidates: buildSelectorCandidates(primary, hit.ancestors),
        role: primary.role,
        text: primary.text,
        ariaLabel: primary.ariaLabel,
        tagName: primary.tagName,
        classTokens: primary.classTokens,
        rect: primary.rect,
        ancestors: hit.ancestors.map(toAncestorFingerprint),
    };
};
