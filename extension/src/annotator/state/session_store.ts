import type { CanvasDraft, PageIdentity } from '../types.js';
import { MSG } from '../../shared/protocol.js';

export type SessionDraftKey = string;

export type SessionStorageLike = {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

export type ChromeSessionStorageArea = {
    get: (key: string) => Promise<Record<string, unknown>>;
    set: (items: Record<string, unknown>) => Promise<void>;
    remove: (key: string) => Promise<void>;
};

export type RuntimeSessionStorageReply = {
    ok: boolean;
    value?: unknown;
    error?: string;
};

export type RuntimeSessionStorageSender = (
    message: Record<string, unknown>,
) => Promise<RuntimeSessionStorageReply>;

export type SessionStore = {
    saveDraft: (key: SessionDraftKey, draft: CanvasDraft, pageIdentity: PageIdentity) => Promise<void>;
    loadDraft: (key: SessionDraftKey, expectedPage: PageIdentity) => Promise<CanvasDraft | null>;
    clearDraft: (key: SessionDraftKey) => Promise<void>;
};

const KEY_PREFIX = 'rpa.entity_rules.annotator.draft:';

type StoredEntry = {
    pageIdentity: PageIdentity;
    draft: CanvasDraft;
    savedAt: number;
};

const isPageIdentity = (value: unknown): value is PageIdentity => {
    if (!value || typeof value !== 'object') {return false;}
    const record = value as Record<string, unknown>;
    return (
        typeof record.workspaceName === 'string' &&
        typeof record.tabName === 'string' &&
        typeof record.url === 'string'
    );
};

const isStoredEntry = (value: unknown): value is StoredEntry => {
    if (!value || typeof value !== 'object') {return false;}
    const record = value as Record<string, unknown>;
    return isPageIdentity(record.pageIdentity) && !!record.draft && typeof record.savedAt === 'number';
};

const samePage = (a: PageIdentity, b: PageIdentity): boolean =>
    a.workspaceName === b.workspaceName &&
    a.tabName === b.tabName &&
    a.url === b.url;

export const composeKey = (parts: {
    workspaceName: string;
    tabName: string;
    pageIdentity: PageIdentity;
    profileName: string | null;
}): SessionDraftKey => {
    const profile = parts.profileName || '__none__';
    return [
        KEY_PREFIX,
        parts.workspaceName,
        parts.tabName,
        parts.pageIdentity.url,
        profile,
    ].join('|');
};

export const createSessionStore = (storage: SessionStorageLike): SessionStore => ({
    saveDraft: async (key, draft, pageIdentity) => {
        const entry: StoredEntry = {
            pageIdentity,
            draft: JSON.parse(JSON.stringify(draft)) as CanvasDraft,
            savedAt: Date.now(),
        };
        await storage.set(key, entry);
    },
    loadDraft: async (key, expectedPage) => {
        const raw = await storage.get(key);
        if (!isStoredEntry(raw)) {return null;}
        if (!samePage(raw.pageIdentity, expectedPage)) {return null;}
        return JSON.parse(JSON.stringify(raw.draft)) as CanvasDraft;
    },
    clearDraft: async (key) => {
        await storage.remove(key);
    },
});

export const createChromeSessionStorage = (
    area: ChromeSessionStorageArea,
): SessionStorageLike => ({
    get: async (key) => (await area.get(key))[key] ?? null,
    set: async (key, value) => {
        await area.set({[key]: value});
    },
    remove: async (key) => {
        await area.remove(key);
    },
});

export const createRuntimeSessionStorage = (
    sendMessage: RuntimeSessionStorageSender,
): SessionStorageLike => {
    const request = async (
        operation: 'get' | 'set' | 'remove',
        key: string,
        value?: unknown,
    ): Promise<RuntimeSessionStorageReply> => {
        const reply = await sendMessage({
            type: MSG.ANNOTATOR_SESSION_STORAGE,
            operation,
            key,
            ...(operation === 'set' ? {value} : {}),
        });
        if (!reply?.ok) {
            throw new Error(reply?.error || 'annotator session storage request failed');
        }
        return reply;
    };
    return {
        get: async (key) => (await request('get', key)).value ?? null,
        set: async (key, value) => {
            await request('set', key, value);
        },
        remove: async (key) => {
            await request('remove', key);
        },
    };
};
