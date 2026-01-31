export type TabGroupColor =
    | 'grey'
    | 'blue'
    | 'red'
    | 'yellow'
    | 'green'
    | 'pink'
    | 'purple'
    | 'cyan'
    | 'orange';

export const ALLOWED_GROUP_COLORS: TabGroupColor[] = [
    'grey',
    'blue',
    'red',
    'yellow',
    'green',
    'pink',
    'purple',
    'cyan',
    'orange',
];

export const pickRandomGroupColor = (rng: () => number = Math.random): TabGroupColor => {
    const index = Math.floor(rng() * ALLOWED_GROUP_COLORS.length);
    return ALLOWED_GROUP_COLORS[index] || 'blue';
};

export type WorkspaceMeta = {
    displayName: string;
    groupId?: number;
    color?: TabGroupColor;
    createdAt: number;
    updatedAt: number;
};

export type TabMeta = {
    displayName: string;
    createdAt: number;
    updatedAt: number;
};

export type MetaStore = {
    nextWorkspaceIndex: number;
    nextTabIndexByWorkspace: Record<string, number>;
    workspaces: Record<string, WorkspaceMeta>;
    tabs: Record<string, Record<string, TabMeta>>;
};

const STORAGE_KEY = 'rpaWorkspaceMeta';

const defaultStore = (): MetaStore => ({
    nextWorkspaceIndex: 1,
    nextTabIndexByWorkspace: {},
    workspaces: {},
    tabs: {},
});

type StorageLike = {
    get: (key: string) => Promise<Record<string, any>>;
    set: (value: Record<string, any>) => Promise<void>;
};

const getStorage = (storage?: StorageLike) => storage || chrome.storage.local;

export const loadMetaStore = async (storage?: StorageLike): Promise<MetaStore> => {
    const store = getStorage(storage);
    const data = await store.get(STORAGE_KEY);
    const raw = data[STORAGE_KEY] as MetaStore | undefined;
    if (!raw) return defaultStore();
    return {
        nextWorkspaceIndex: raw.nextWorkspaceIndex || 1,
        nextTabIndexByWorkspace: raw.nextTabIndexByWorkspace || {},
        workspaces: raw.workspaces || {},
        tabs: raw.tabs || {},
    };
};

export const saveMetaStore = async (meta: MetaStore, storage?: StorageLike) => {
    const store = getStorage(storage);
    await store.set({ [STORAGE_KEY]: meta });
};

export const ensureWorkspaceMeta = async (
    workspaceId: string,
    storage?: StorageLike,
): Promise<WorkspaceMeta> => {
    const meta = await loadMetaStore(storage);
    let workspace = meta.workspaces[workspaceId];
    if (!workspace) {
        const now = Date.now();
        workspace = {
            displayName: `Workspace ${meta.nextWorkspaceIndex}`,
            createdAt: now,
            updatedAt: now,
            color: pickRandomGroupColor(),
        };
        meta.nextWorkspaceIndex += 1;
        meta.workspaces[workspaceId] = workspace;
        meta.tabs[workspaceId] = meta.tabs[workspaceId] || {};
        meta.nextTabIndexByWorkspace[workspaceId] = meta.nextTabIndexByWorkspace[workspaceId] || 1;
        await saveMetaStore(meta, storage);
        return workspace;
    }
    if (!workspace.color) {
        workspace.color = pickRandomGroupColor();
        workspace.updatedAt = Date.now();
        meta.workspaces[workspaceId] = workspace;
        await saveMetaStore(meta, storage);
    }
    return workspace;
};

export const updateWorkspaceMeta = async (
    workspaceId: string,
    updates: Partial<WorkspaceMeta>,
    storage?: StorageLike,
): Promise<WorkspaceMeta | null> => {
    const meta = await loadMetaStore(storage);
    const existing = meta.workspaces[workspaceId];
    if (!existing) return null;
    meta.workspaces[workspaceId] = {
        ...existing,
        ...updates,
        updatedAt: Date.now(),
    };
    await saveMetaStore(meta, storage);
    return meta.workspaces[workspaceId];
};

export const ensureTabMeta = async (
    workspaceId: string,
    tabId: string,
    storage?: StorageLike,
): Promise<TabMeta> => {
    const meta = await loadMetaStore(storage);
    meta.tabs[workspaceId] = meta.tabs[workspaceId] || {};
    let tab = meta.tabs[workspaceId][tabId];
    if (!tab) {
        const now = Date.now();
        const index = meta.nextTabIndexByWorkspace[workspaceId] || 1;
        tab = {
            displayName: `Tab ${index}`,
            createdAt: now,
            updatedAt: now,
        };
        meta.nextTabIndexByWorkspace[workspaceId] = index + 1;
        meta.tabs[workspaceId][tabId] = tab;
        await saveMetaStore(meta, storage);
    }
    return tab;
};

export const withWorkspaceDisplayNames = async <T extends { workspaceId: string }>(
    workspaces: T[],
    storage?: StorageLike,
): Promise<Array<T & { displayName: string }>> => {
    const meta = await loadMetaStore(storage);
    let changed = false;
    for (const workspace of workspaces) {
        if (!meta.workspaces[workspace.workspaceId]) {
            const now = Date.now();
            meta.workspaces[workspace.workspaceId] = {
                displayName: `Workspace ${meta.nextWorkspaceIndex}`,
                createdAt: now,
                updatedAt: now,
                color: pickRandomGroupColor(),
            };
            meta.nextWorkspaceIndex += 1;
            meta.tabs[workspace.workspaceId] = meta.tabs[workspace.workspaceId] || {};
            meta.nextTabIndexByWorkspace[workspace.workspaceId] =
                meta.nextTabIndexByWorkspace[workspace.workspaceId] || 1;
            changed = true;
        }
    }
    if (changed) {
        await saveMetaStore(meta, storage);
    }
    return workspaces.map((workspace) => ({
        ...workspace,
        displayName: meta.workspaces[workspace.workspaceId]?.displayName || workspace.workspaceId,
    }));
};

export const withTabDisplayNames = async <T extends { tabId: string }>(
    workspaceId: string,
    tabs: T[],
    storage?: StorageLike,
): Promise<Array<T & { displayName: string }>> => {
    const meta = await loadMetaStore(storage);
    meta.tabs[workspaceId] = meta.tabs[workspaceId] || {};
    let changed = false;
    for (const tab of tabs) {
        if (!meta.tabs[workspaceId][tab.tabId]) {
            const now = Date.now();
            const index = meta.nextTabIndexByWorkspace[workspaceId] || 1;
            meta.tabs[workspaceId][tab.tabId] = {
                displayName: `Tab ${index}`,
                createdAt: now,
                updatedAt: now,
            };
            meta.nextTabIndexByWorkspace[workspaceId] = index + 1;
            changed = true;
        }
    }
    if (changed) {
        await saveMetaStore(meta, storage);
    }
    return tabs.map((tab) => ({
        ...tab,
        displayName: meta.tabs[workspaceId][tab.tabId]?.displayName || tab.tabId,
    }));
};
