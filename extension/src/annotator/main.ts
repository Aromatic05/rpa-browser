import {createApp, reactive, type App as VueApp} from 'vue';
import RootApp from './App.vue';
import {ANNOTATOR_CSS} from './styles.js';
import {initialState, type AnnotatorState} from './state/annotator_state.js';
import {runRecognizeLoop} from './state/annotator_loop.js';
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
import {
    createSessionStore,
    createChromeSessionStorage,
    type SessionStorageLike,
    type SessionStore,
} from './state/session_store.js';

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

const memoryStorage = (): SessionStorageLike & {_store: Map<string, unknown>} => {
    const store = new Map<string, unknown>();
    return {
        _store: store,
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => {
            store.set(key, value);
        },
        remove: async (key) => {
            store.delete(key);
        },
    };
};

const compiledComponentCss = (): string => {
    const css = (globalThis as {__rpaAnnotatorComponentCss?: unknown}).__rpaAnnotatorComponentCss;
    return typeof css === 'string' ? css : '';
};

const createExtensionSessionStorage = (): SessionStorageLike => {
    const area = typeof chrome === 'undefined' ? null : chrome.storage?.session;
    if (!area) {
        return memoryStorage();
    }
    return createChromeSessionStorage(area);
};

const mountVueApp: MountAppFn = (root, handlers) => {
    const styleEl = root.ownerDocument.createElement('style');
    styleEl.setAttribute('data-rpa-annotator-style', 'true');
    styleEl.textContent = `${ANNOTATOR_CSS}\n${compiledComponentCss()}`;
    root.appendChild(styleEl);
    const appRoot = root.ownerDocument.createElement('div');
    appRoot.setAttribute('data-rpa-annotator-app', 'true');
    root.appendChild(appRoot);
    const reactiveState = reactive(initialState()) as AnnotatorState;
    const client = buildClient(handlers.dispatch);
    const sessionStore: SessionStore = createSessionStore(createExtensionSessionStorage());
    const app: VueApp = createApp(RootApp, {
        state: reactiveState,
        client,
        sessionStore,
        onExit: handlers.onExit,
    });
    app.mount(appRoot);
    let recognizeRequest = 0;
    const handle: AnnotatorAppHandle = {
        setState: (next) => {
            Object.assign(reactiveState, next);
        },
        getState: () => reactiveState,
        afterOpen: (state) => {
            if (state.canvasDraft) {
                return;
            }
            const request = ++recognizeRequest;
            void runRecognizeLoop(state, client).then((next) => {
                if (request !== recognizeRequest || reactiveState.pageIdentity !== state.pageIdentity || reactiveState.canvasDraft) {
                    return;
                }
                Object.assign(reactiveState, next);
            });
        },
        unmount: () => {
            app.unmount();
        },
    };
    return handle;
};

export const startAnnotator = (handlers: AnnotatorHandlers, doc?: Document): AnnotatorHandle =>
    mountAnnotator({handlers, mountApp: mountVueApp, ...(doc ? {document: doc} : {})});
