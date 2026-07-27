import test from 'node:test';
import assert from 'node:assert/strict';
import {
    composeKey,
    createChromeSessionStorage,
    createRuntimeSessionStorage,
    createSessionStore,
    type SessionStorageLike,
} from '../state/session_store.js';
import type { CanvasDraft, PageIdentity } from '../types.js';

type Entry = { key: string; value: unknown };

const createMemoryStorage = (): SessionStorageLike & { _store: Map<string, unknown> } => {
    const store = new Map<string, unknown>();
    return {
        _store: store,
        get: async (key) => store.get(key) ?? null,
        set: async (key, value) => {
            store.set(key, JSON.parse(JSON.stringify(value)));
        },
        remove: async (key) => {
            store.delete(key);
        },
    };
};

const draft: CanvasDraft = {
    version: 1,
    profileName: 'profile-a',
    page: { kind: 'table' },
    entities: [],
    preserved: {},
};

const pageA: PageIdentity = { workspaceName: 'ws-1', tabName: 'tab-1', url: 'http://test/a' };
const pageB: PageIdentity = { workspaceName: 'ws-1', tabName: 'tab-1', url: 'http://test/b' };

test('composeKey embeds workspace, tab, url, profile', () => {
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    assert.match(key, /ws-1/);
    assert.match(key, /tab-1/);
    assert.match(key, /http:\/\/test\/a/);
    assert.match(key, /profile-a/);
});

test('composeKey uses __none__ sentinel when profileName is null', () => {
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: null,
    });
    assert.match(key, /__none__/);
});

test('saveDraft then loadDraft returns the draft when page identity matches', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    await store.saveDraft(key, draft, pageA);
    const loaded = await store.loadDraft(key, pageA);
    assert.deepEqual(loaded, draft);
});

test('chrome session adapter persists through the extension storage area', async () => {
    const values = new Map<string, unknown>();
    const storage = createChromeSessionStorage({
        get: async (key) => ({[key]: values.get(key)}),
        set: async (items) => {
            for (const [key, value] of Object.entries(items)) {
                values.set(key, value);
            }
        },
        remove: async (key) => {
            values.delete(key);
        },
    });
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: pageA.workspaceName,
        tabName: pageA.tabName,
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    await store.saveDraft(key, draft, pageA);
    assert.deepEqual(await store.loadDraft(key, pageA), draft);
    await store.clearDraft(key);
    assert.equal(await store.loadDraft(key, pageA), null);
});

test('runtime session adapter proxies get/set/remove through the service worker message bridge', async () => {
    const values = new Map<string, unknown>();
    const messages: Record<string, unknown>[] = [];
    const storage = createRuntimeSessionStorage(async (message) => {
        messages.push(message);
        const key = String(message.key || '');
        if (message.operation === 'get') {
            return {ok: true, value: values.get(key) ?? null};
        }
        if (message.operation === 'set') {
            values.set(key, message.value);
            return {ok: true};
        }
        if (message.operation === 'remove') {
            values.delete(key);
            return {ok: true};
        }
        return {ok: false, error: 'unsupported'};
    });
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: pageA.workspaceName,
        tabName: pageA.tabName,
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    await store.saveDraft(key, draft, pageA);
    assert.deepEqual(await store.loadDraft(key, pageA), draft);
    await store.clearDraft(key);
    assert.equal(await store.loadDraft(key, pageA), null);
    assert.deepEqual(messages.map((message) => message.operation), ['set', 'get', 'remove', 'get']);
});

test('loadDraft returns null when page identity mismatches', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    await store.saveDraft(key, draft, pageA);
    const loaded = await store.loadDraft(key, pageB);
    assert.equal(loaded, null);
});

test('loadDraft returns null when nothing stored', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    const loaded = await store.loadDraft(key, pageA);
    assert.equal(loaded, null);
});

test('clearDraft removes the stored entry', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const key = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    await store.saveDraft(key, draft, pageA);
    await store.clearDraft(key);
    const loaded = await store.loadDraft(key, pageA);
    assert.equal(loaded, null);
});

test('loadDraft returns null when stored value is malformed', async () => {
    const storage = createMemoryStorage();
    storage._store.set('bad-key', { notAnEntry: true });
    const store = createSessionStore(storage);
    const loaded = await store.loadDraft('bad-key', pageA);
    assert.equal(loaded, null);
});

test('saveDraft isolates drafts by key (different profiles do not collide)', async () => {
    const storage = createMemoryStorage();
    const store = createSessionStore(storage);
    const keyA = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-a',
    });
    const keyB = composeKey({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageIdentity: pageA,
        profileName: 'profile-b',
    });
    await store.saveDraft(keyA, draft, pageA);
    const draftB: CanvasDraft = { ...draft, profileName: 'profile-b' };
    await store.saveDraft(keyB, draftB, pageA);
    assert.deepEqual(await store.loadDraft(keyA, pageA), draft);
    assert.deepEqual(await store.loadDraft(keyB, pageA), draftB);
});
