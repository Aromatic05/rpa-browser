import {createApp, reactive, type App as VueApp} from 'vue';
import RootApp from './App.vue';
import {ANNOTATOR_CSS} from './styles.js';
import {initialState, type AnnotatorState} from './state/annotator_state.js';
import {
    mountAnnotator,
    type AnnotatorAppHandle,
    type AnnotatorHandle,
    type AnnotatorHandlers,
    type MountAppFn,
} from './mount.js';
import {
    createAnnotatorClient,
    type AnnotatorClient,
    type AnnotatorReply,
} from './protocol/annotator_client.js';

export type {AnnotatorHandle, AnnotatorHandlers} from './mount.js';

const buildClient = (
    dispatch: ((type: string, payload?: Record<string, unknown>) => Promise<unknown>) | undefined,
): AnnotatorClient | null => {
    if (!dispatch) {return null;}
    const wrapped = async (type: string, payload?: Record<string, unknown>): Promise<AnnotatorReply> => {
        const result = await dispatch(type, payload);
        if (result && typeof result === 'object' && 'type' in result) {
            const action = result as {type: string; payload?: unknown};
            return {
                type: action.type,
                payload: action.payload,
            };
        }
        return {type: `${type}.failed`, payload: {message: 'invalid dispatch reply'}};
    };
    return createAnnotatorClient(wrapped);
};

const mountVueApp: MountAppFn = (root, handlers) => {
    const styleEl = root.ownerDocument.createElement('style');
    styleEl.setAttribute('data-rpa-annotator-style', 'true');
    styleEl.textContent = ANNOTATOR_CSS;
    root.appendChild(styleEl);
    const reactiveState = reactive(initialState()) as AnnotatorState;
    const client = buildClient(handlers.dispatch);
    const app: VueApp = createApp(RootApp, {
        state: reactiveState,
        client,
        onExit: handlers.onExit,
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
    mountAnnotator({handlers, mountApp: mountVueApp, ...(doc ? {document: doc} : {})});
