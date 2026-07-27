import type {PickFingerprint, PickRect} from '../types.js';
import {
    buildFingerprintFromHitTest,
    isPickerHost,
    shouldInterceptClick,
    type DOMElFingerprint,
    type HitTestInput,
} from './capture_picker.js';

export type PickerEvent = {
    fingerprint: PickFingerprint;
    pointer: {x: number; y: number};
};

export type PickerHandlers = {
    onHover?: (rect: PickRect | null, pointer: {x: number; y: number}) => void;
    onPick?: (event: PickerEvent) => void;
    isActive: () => boolean;
};

const WHITESPACE = /\s+/;

const readClassTokens = (element: Element): string[] => {
    const raw = element.getAttribute('class') ?? '';
    if (!raw) {return [];}
    return raw.split(WHITESPACE).filter((token) => token.length > 0);
};

const readText = (element: Element): string => {
    const label = element.getAttribute('aria-label') ?? '';
    if (label) {return label;}
    if (element.textContent) {
        return element.textContent.trim().slice(0, 64);
    }
    return '';
};

const readRect = (element: Element): PickRect => {
    const rect = element.getBoundingClientRect();
    return {
        x: rect.left + (typeof window !== 'undefined' ? window.scrollX : 0),
        y: rect.top + (typeof window !== 'undefined' ? window.scrollY : 0),
        width: rect.width,
        height: rect.height,
    };
};

const toFingerprint = (element: Element): DOMElFingerprint => ({
    tagName: element.tagName,
    classTokens: readClassTokens(element),
    role: element.getAttribute('role') ?? undefined,
    text: readText(element),
    ariaLabel: element.getAttribute('aria-label') ?? undefined,
    rect: readRect(element),
});

const collectAncestors = (element: Element, maxDepth = 8): DOMElFingerprint[] => {
    const out: DOMElFingerprint[] = [];
    let cursor: Element | null = element.parentElement;
    let depth = 0;
    while (cursor && depth < maxDepth) {
        out.push(toFingerprint(cursor));
        cursor = cursor.parentElement;
        depth += 1;
    }
    return out;
};

const buildHitTest = (event: PointerEvent | MouseEvent): HitTestInput => {
    const doc = (event.view?.document ?? (typeof document !== 'undefined' ? document : null)) as Document | null;
    const point = {
        x: event.clientX + (doc?.defaultView?.scrollX ?? 0),
        y: event.clientY + (doc?.defaultView?.scrollY ?? 0),
    };
    const elementsFromPoint = doc?.elementFromPoint
        ? Array.from(doc.elementsFromPoint(event.clientX, event.clientY))
        : [];
    const filtered = elementsFromPoint.filter((el) => !isPickerHost(el));
    const primary = filtered[0] ?? (event.target instanceof Element ? event.target : null);
    const elements: DOMElFingerprint[] = primary ? [toFingerprint(primary)] : [];
    const ancestors = primary ? collectAncestors(primary) : [];
    return {point, elements, ancestors};
};

const INTERACTIVE_TAGS = new Set(['A', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'LABEL']);

export type PickerDetach = () => void;

export const attachPickerListeners = (
    doc: Document,
    handlers: PickerHandlers,
): PickerDetach => {
    const onPointerMove = (event: PointerEvent): void => {
        if (!handlers.isActive()) {return;}
        if (!(event.target instanceof Element)) {return;}
        if (isPickerHost(event.target)) {return;}
        const rect = event.target.getBoundingClientRect();
        const pointer = {
            x: event.clientX + (doc.defaultView?.scrollX ?? 0),
            y: event.clientY + (doc.defaultView?.scrollY ?? 0),
        };
        handlers.onHover?.(
            {
                x: rect.left + (doc.defaultView?.scrollX ?? 0),
                y: rect.top + (doc.defaultView?.scrollY ?? 0),
                width: rect.width,
                height: rect.height,
            },
            pointer,
        );
    };

    const onClick = (event: MouseEvent): void => {
        if (!handlers.isActive()) {return;}
        if (!(event.target instanceof Element)) {return;}
        if (!shouldInterceptClick(event.target)) {return;}
        event.preventDefault();
        event.stopPropagation();
        if (event.target instanceof HTMLElement) {
            const tag = event.target.tagName.toUpperCase();
            if (INTERACTIVE_TAGS.has(tag)) {
                event.target.blur();
            }
        }
        const hit = buildHitTest(event);
        const fingerprint = buildFingerprintFromHitTest(hit);
        handlers.onPick?.({
            fingerprint,
            pointer: hit.point,
        });
    };

    const options = {capture: true} as EventListenerOptions;
    doc.addEventListener('pointermove', onPointerMove, options);
    doc.addEventListener('click', onClick, true);
    return () => {
        doc.removeEventListener('pointermove', onPointerMove, options);
        doc.removeEventListener('click', onClick, true);
    };
};
