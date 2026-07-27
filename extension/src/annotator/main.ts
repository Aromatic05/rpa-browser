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
import {
    createSessionStore,
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

const createWebSessionStorage = (): SessionStorageLike => {
    if (typeof window === 'undefined') {
        return memoryStorage();
    }
    try {
        const storage = window.sessionStorage;
        const probeKey = '__rpa_annotator_storage_probe__';
        storage.setItem(probeKey, '1');
        storage.removeItem(probeKey);
        return {
            get: async (key) => {
                const raw = storage.getItem(key);
                return raw ? (JSON.parse(raw) as unknown) : null;
            },
            set: async (key, value) => {
                storage.setItem(key, JSON.stringify(value));
            },
            remove: async (key) => {
                storage.removeItem(key);
            },
        };
    } catch {
        return memoryStorage();
    }
};

const mountVueApp: MountAppFn = (root, handlers) => {
    const styleEl = root.ownerDocument.createElement('style');
    styleEl.setAttribute('data-rpa-annotator-style', 'true');
    styleEl.textContent = `${ANNOTATOR_CSS}\n${compiledComponentCss()}`;
    root.appendChild(styleEl);
    const reactiveState = reactive(initialState()) as AnnotatorState;
    const client = buildClient(handlers.dispatch);
    const sessionStore: SessionStore = createSessionStore(createWebSessionStorage());
    const app: VueApp = createApp(RootApp, {
        state: reactiveState,
        client,
        sessionStore,
        onExit: handlers.onExit,
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
