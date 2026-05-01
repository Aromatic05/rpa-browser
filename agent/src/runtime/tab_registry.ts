import type { Page } from 'playwright';

export type RuntimeTab = {
    name: string;
    tabName: string;
    page: Page | null;
    url: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

export type TabRegistry = {
    createTab: (input: { tabName: string; tabName: string; page?: Page | null; url?: string; title?: string; at?: number }) => RuntimeTab;
    closeTab: (tabName: string) => RuntimeTab | null;
    listTabs: () => RuntimeTab[];
    setActiveTab: (tabName: string) => void;
    getActiveTab: () => RuntimeTab | null;
    hasTab: (tabName: string) => boolean;
    getTab: (tabName: string) => RuntimeTab | null;
    resolveTab: (tabName?: string) => RuntimeTab;
    bindPage: (tabName: string, page: Page) => RuntimeTab | null;
    updateTab: (tabName: string, patch: Partial<Pick<RuntimeTab, 'url' | 'title' | 'updatedAt'>>) => RuntimeTab | null;
};

export const createTabRegistry = (): TabRegistry => {
    const tabs = new Map<string, RuntimeTab>();
    let activeTabName: string | null = null;

    const createTab: TabRegistry['createTab'] = (input) => {
        if (tabs.has(input.tabName)) {
            throw new Error(`tab already exists: ${input.tabName}`);
        }
        const now = input.at ?? Date.now();
        const tab: RuntimeTab = {
            name: input.tabName,
            tabName: input.tabName,
            page: input.page ?? null,
            url: input.url ?? '',
            title: input.title ?? '',
            createdAt: now,
            updatedAt: now,
        };
        tabs.set(input.tabName, tab);
        if (!activeTabName) {
            activeTabName = input.tabName;
        }
        return tab;
    };

    const closeTab: TabRegistry['closeTab'] = (tabName) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) {return null;}
        tabs.delete(tabName);
        if (activeTabName === tabName) {
            activeTabName = tabs.keys().next().value ?? null;
        }
        return tab;
    };

    const listTabs = () => Array.from(tabs.values());

    const setActiveTab = (tabName: string) => {
        if (!tabs.has(tabName)) {
            throw new Error(`tab not found: ${tabName}`);
        }
        activeTabName = tabName;
    };

    const getActiveTab = () => (activeTabName ? tabs.get(activeTabName) || null : null);

    const getTab = (tabName: string) => tabs.get(tabName) || null;

    const resolveTab = (tabName?: string) => {
        if (tabName) {
            const tab = tabs.get(tabName);
            if (!tab) {throw new Error(`tab not found: ${tabName}`);}
            return tab;
        }
        const active = getActiveTab();
        if (!active) {throw new Error('active tab not found');}
        return active;
    };

    const bindPage = (tabName: string, page: Page) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) {return null;}
        tab.page = page;
        tab.url = page.url();
        tab.updatedAt = Date.now();
        return tab;
    };

    const updateTab = (tabName: string, patch: Partial<Pick<RuntimeTab, 'url' | 'title' | 'updatedAt'>>) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) {return null;}
        if (typeof patch.url === 'string') {tab.url = patch.url;}
        if (typeof patch.title === 'string') {tab.title = patch.title;}
        tab.updatedAt = patch.updatedAt ?? Date.now();
        return tab;
    };

    return {
        createTab,
        closeTab,
        listTabs,
        setActiveTab,
        getActiveTab,
        hasTab: (tabName) => tabs.has(tabName),
        getTab,
        resolveTab,
        bindPage,
        updateTab,
    };
};
