import { createApp, reactive, type App as VueApp } from 'vue';
import RootApp from './App.vue';
import { ANNOTATOR_CSS } from './styles.js';
import { initialState, type AnnotatorState } from './state/annotator_state.js';
import {
    mountAnnotator,
    type AnnotatorAppHandle,
    type AnnotatorHandle,
    type AnnotatorHandlers,
    type MountAppFn,
} from './mount.js';

export type { AnnotatorHandle, AnnotatorHandlers } from './mount.js';

const mountVueApp: MountAppFn = (root, handlers) => {
    const styleEl = root.ownerDocument.createElement('style');
    styleEl.setAttribute('data-rpa-annotator-style', 'true');
    styleEl.textContent = ANNOTATOR_CSS;
    root.appendChild(styleEl);
    const reactiveState = reactive(initialState()) as AnnotatorState;
    const app: VueApp = createApp(RootApp, {
        state: reactiveState,
        onExit: handlers.onExit,
        onUndo: handlers.onUndo,
        onRedo: handlers.onRedo,
        onCheck: handlers.onCheck,
        onSave: handlers.onSave,
    });
    app.mount(root);
    const handle: AnnotatorAppHandle = {
        setState: (next) => {
            Object.assign(reactiveState, next);
        },
        getState: () => reactiveState,
        unmount: () => {
            app.unmount();
        },
    };
    return handle;
};

export const startAnnotator = (handlers: AnnotatorHandlers, doc?: Document): AnnotatorHandle =>
    mountAnnotator({ handlers, mountApp: mountVueApp, ...(doc ? { document: doc } : {}) });
