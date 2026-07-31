import {annotationIdFromDomTarget} from './dom_markers.js';

export const annotationIdBelowInteractionShield = (
    event: MouseEvent,
    shield: HTMLElement,
    documentRef: Document,
): string | null => {
    if (event.composedPath().at(0) !== shield) {return null;}
    const previousPointerEvents = shield.style.pointerEvents;
    shield.style.pointerEvents = 'none';
    try {
        return annotationIdFromDomTarget(documentRef.elementFromPoint(event.clientX, event.clientY));
    } finally {
        shield.style.pointerEvents = previousPointerEvents;
    }
};
