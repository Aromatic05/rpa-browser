import type {AnnotatorState} from './state/annotator_state.js';

export const ANNOTATOR_HOST_ID = 'rpa-entity-annotator-host';

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
    host.style.position = 'fixed';
    host.style.top = '0';
    host.style.left = '0';
    host.style.width = '0';
    host.style.height = '0';
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
};

export const mountAnnotator = (opts: AnnotatorMountOptions): AnnotatorHandle => {
    const doc = opts.document ?? document;
    const {host, shadow} = createAnnotatorHost(doc);
    const app = opts.mountApp(shadow, opts.handlers);
    doc.documentElement.appendChild(host);
    return {
        unmount: () => {
            app.unmount();
            host.remove();
        },
        show: () => {
            host.style.display = 'block';
            host.style.pointerEvents = 'auto';
        },
        hide: () => {
            host.style.display = 'none';
            host.style.pointerEvents = 'none';
        },
        setState: (state) => {
            app.setState(state);
        },
        getState: () => app.getState(),
    };
};
