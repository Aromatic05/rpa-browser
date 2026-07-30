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

export const viewportRect = (rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>): PickRect => ({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
});

const readRect = (element: Element): PickRect => {
    const rect = element.getBoundingClientRect();
    return viewportRect(rect);
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
        x: event.clientX,
        y: event.clientY,
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
            x: event.clientX,
            y: event.clientY,
        };
        handlers.onHover?.(
            viewportRect(rect),
            pointer,
        );
    };

    const consumePageInteraction = (event: Event): event is PointerEvent | MouseEvent => {
        if (!handlers.isActive()) {return false;}
        if (!(event.target instanceof Element)) {return false;}
        if (!shouldInterceptClick(event.target)) {return false;}
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.target instanceof HTMLElement && INTERACTIVE_TAGS.has(event.target.tagName.toUpperCase())) {
            event.target.blur();
        }
        return event instanceof PointerEvent || event instanceof MouseEvent;
    };

    const onPointerDown = (event: PointerEvent): void => {
        if (event.button !== 0 || !consumePageInteraction(event)) {return;}
        const hit = buildHitTest(event);
        const fingerprint = buildFingerprintFromHitTest(hit);
        handlers.onPick?.({
            fingerprint,
            pointer: hit.point,
        });
    };

    const onBlockedInteraction = (event: Event): void => {
        consumePageInteraction(event);
    };

    const options = {capture: true} as EventListenerOptions;
    doc.addEventListener('pointermove', onPointerMove, options);
    doc.addEventListener('pointerdown', onPointerDown, options);
    doc.addEventListener('mousedown', onBlockedInteraction, options);
    doc.addEventListener('pointerup', onBlockedInteraction, options);
    doc.addEventListener('mouseup', onBlockedInteraction, options);
    doc.addEventListener('click', onBlockedInteraction, options);
    return () => {
        doc.removeEventListener('pointermove', onPointerMove, options);
        doc.removeEventListener('pointerdown', onPointerDown, options);
        doc.removeEventListener('mousedown', onBlockedInteraction, options);
        doc.removeEventListener('pointerup', onBlockedInteraction, options);
        doc.removeEventListener('mouseup', onBlockedInteraction, options);
        doc.removeEventListener('click', onBlockedInteraction, options);
    };
};
