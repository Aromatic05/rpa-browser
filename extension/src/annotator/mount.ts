import type {AnnotatorOpenResult} from './types.js';
import {
    exitAnnotation,
    openLoaded,
    type AnnotatorState,
} from './state/annotator_state.js';

export const ANNOTATOR_HOST_ID = 'rpa-entity-annotator-host';

export type AnnotatorInteractionMode = 'edit' | 'inspect' | 'passthrough';

export type AnnotatorDispatch = (
    type: string,
    payload?: Record<string, unknown>,
) => Promise<unknown>;

export type AnnotatorHandlers = {
    onExit: () => void;
    onUndo: () => void;
    onRedo: () => void;
    onCheck: () => void;
    onSave: () => void;
    onPickModeChange?: (picking: boolean) => void;
    onDebugState?: (detail: string) => void;
    dispatch?: AnnotatorDispatch;
};

export type AnnotatorAppHandle = {
    setState: (state: AnnotatorState) => void;
    getState: () => AnnotatorState;
    unmount: () => void;
};

export type MountAppFn = (root: ShadowRoot, handlers: AnnotatorHandlers) => AnnotatorAppHandle;

export type AnnotatorHost = {
    host: HTMLDivElement;
    shadow: ShadowRoot;
};

export const createAnnotatorHost = (doc: Document): AnnotatorHost => {
    const existing = doc.getElementById(ANNOTATOR_HOST_ID);
    if (existing) {
        existing.remove();
    }
    const host = doc.createElement('div');
    host.id = ANNOTATOR_HOST_ID;
    host.setAttribute('data-rpa-panel', 'true');
    host.setAttribute('data-rpa-annotator-host', 'true');
    host.setAttribute('data-rpa-snapshot-ignore', 'true');
    host.style.all = 'initial';
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.right = '0';
    host.style.bottom = '0';
    host.style.width = '100vw';
    host.style.height = '100vh';
    host.style.margin = '0';
    host.style.padding = '0';
    host.style.border = '0';
    host.style.zoom = '1';
    host.style.transform = 'none';
    host.style.transformOrigin = '0 0';
    host.style.contain = 'layout style size';
    host.style.isolation = 'isolate';
    host.style.zIndex = '2147483646';
    host.style.display = 'none';
    host.style.pointerEvents = 'none';
    const shadow = host.attachShadow({mode: 'open'});
    return {host, shadow};
};

export type AnnotatorMountOptions = {
    document?: Document;
    handlers: AnnotatorHandlers;
    mountApp: MountAppFn;
};

export type AnnotatorHandle = {
    unmount: () => void;
    show: () => void;
    hide: () => void;
    setState: (state: AnnotatorState) => void;
    getState: () => AnnotatorState;
    open: (result: AnnotatorOpenResult) => void;
    exit: () => void;
    setInteractionMode: (mode: AnnotatorInteractionMode) => void;
};

export const mountAnnotator = (opts: AnnotatorMountOptions): AnnotatorHandle => {
    const doc = opts.document ?? document;
    const {host, shadow} = createAnnotatorHost(doc);
    let interactionMode: AnnotatorInteractionMode = 'edit';
    let picking = false;
    let visible = false;
    const blocksPage = (): boolean => interactionMode !== 'passthrough' && !picking;
    const applyInteractionPolicy = (): void => {
        host.style.pointerEvents = visible && blocksPage() ? 'auto' : 'none';
        host.toggleAttribute('data-rpa-highlight-only', interactionMode !== 'edit');
        host.setAttribute('data-rpa-interaction-mode', interactionMode);
        if (visible && blocksPage()) {
            host.focus({preventScroll: true});
        } else if (host.ownerDocument.activeElement === host) {
            host.blur();
        }
    };
    const containBlockedInteraction = (event: Event): void => {
        if (!visible || !blocksPage()) {return;}
        if (event.composedPath().at(0) === host) {event.preventDefault();}
        event.stopPropagation();
    };
    host.tabIndex = -1;
    const containedEvents = [
        'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick',
        'contextmenu', 'keydown', 'keyup', 'keypress',
    ] as const;
    for (const type of containedEvents) {host.addEventListener(type, containBlockedInteraction);}
    host.addEventListener('wheel', containBlockedInteraction, {passive: false});
    host.addEventListener('touchmove', containBlockedInteraction, {passive: false});
    const app = opts.mountApp(shadow, {
        ...opts.handlers,
        onPickModeChange: (nextPicking) => {
            picking = nextPicking;
            applyInteractionPolicy();
            opts.handlers.onPickModeChange?.(nextPicking);
        },
    });
    doc.documentElement.appendChild(host);
    return {
        unmount: () => {
            for (const type of containedEvents) {host.removeEventListener(type, containBlockedInteraction);}
            host.removeEventListener('wheel', containBlockedInteraction);
            host.removeEventListener('touchmove', containBlockedInteraction);
            app.unmount();
            host.remove();
        },
        show: () => {
            visible = true;
            host.style.display = 'block';
            applyInteractionPolicy();
        },
        hide: () => {
            visible = false;
            host.style.display = 'none';
            applyInteractionPolicy();
        },
        setState: (state) => {
            app.setState(state);
        },
        getState: () => app.getState(),
        open: (result) => {
            const state = openLoaded(app.getState(), result);
            app.setState(state);
        },
        exit: () => {
            app.setState(exitAnnotation(app.getState()));
        },
        setInteractionMode: (mode) => {
            interactionMode = mode;
            applyInteractionPolicy();
        },
    };
};
