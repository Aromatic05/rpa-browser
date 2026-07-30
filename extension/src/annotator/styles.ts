export const ANNOTATOR_CSS = `
:host {
    color-scheme: light;
}
[data-rpa-annotator-app="true"] {
    position: fixed;
    inset: 0;
    z-index: 1;
    pointer-events: none;
}
:host([data-rpa-highlight-only]) .floating-dock,
:host([data-rpa-highlight-only]) .annotator-toast,
:host([data-rpa-highlight-only]) .annotator-edit-anchor,
:host([data-rpa-highlight-only]) .pending-edit-anchor,
:host([data-rpa-highlight-only]) .pick-overlay,
:host([data-rpa-highlight-only]) .pick-guide {
    display: none !important;
}
:host([data-rpa-highlight-only]) .annotator-box,
:host([data-rpa-highlight-only]) .annotator-line,
:host([data-rpa-highlight-only]) .annotator-label,
:host([data-rpa-highlight-only]) .annotator-label-layer,
:host([data-rpa-highlight-only]) .annotator-canvas {
    pointer-events: none !important;
    cursor: default !important;
}
`;
