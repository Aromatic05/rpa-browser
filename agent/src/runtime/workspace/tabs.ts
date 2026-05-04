import crypto from 'node:crypto';
import type { Page } from 'playwright';
import { replyAction } from '../../actions/action_protocol';
import { ActionError } from '../../actions/results';
import { ERROR_CODES } from '../../actions/results';
import type { WorkspaceRouterInput } from './router';
import type { ControlPlaneResult } from '../control_plane';

export type RuntimeTab = {
    name: string;
    page: Page | null;
    url: string;
    title: string;
    createdAt: number;
    updatedAt: number;
};

export type WorkspaceTabs = {
    createTab: (input: { tabName: string; page?: Page | null; url?: string; title?: string; at?: number }) => RuntimeTab;
    createMetadataTab: (input: { tabName: string; url?: string; title?: string; at?: number }) => RuntimeTab;
    ensurePage: (tabName: string, startUrl?: string) => Promise<Page>;
    bindPage: (tabName: string, page: Page) => RuntimeTab | null;
    closeTab: (tabName: string) => Promise<RuntimeTab | null>;
    listTabs: () => RuntimeTab[];
    setActiveTab: (tabName: string) => void;
    getActiveTab: () => RuntimeTab | null;
    hasTab: (tabName: string) => boolean;
    getTab: (tabName: string) => RuntimeTab | null;
    resolveTab: (tabName?: string) => RuntimeTab;
    updateTab: (tabName: string, patch: Partial<Pick<RuntimeTab, 'url' | 'title' | 'updatedAt'>>) => RuntimeTab | null;
    reportTab: (tabName: string, input: { url?: string; title?: string; at?: number }) => RuntimeTab | null;
    pingTab: (tabName: string, input: { url?: string; title?: string; at?: number }) => RuntimeTab | null;
    reassignTab: (tabName: string, input: { at?: number }) => RuntimeTab;
};

export type WorkspaceTabsDeps = {
    getPage: (tabName: string, startUrl?: string) => Promise<Page>;
};

const now = () => Date.now();

export const createWorkspaceTabs = (deps: WorkspaceTabsDeps): WorkspaceTabs => {
    const tabs = new Map<string, RuntimeTab>();
    let activeTabName: string | null = null;

    const createTab: WorkspaceTabs['createTab'] = (input) => {
        if (tabs.has(input.tabName)) {
            throw new Error(`tab already exists: ${input.tabName}`);
        }
        const at = input.at ?? now();
        const tab: RuntimeTab = {
            name: input.tabName,
            page: input.page ?? null,
            url: input.url ?? '',
            title: input.title ?? '',
            createdAt: at,
            updatedAt: at,
        };
        tabs.set(input.tabName, tab);
        if (!activeTabName) {
            activeTabName = input.tabName;
        }
        return tab;
    };

    const createMetadataTab: WorkspaceTabs['createMetadataTab'] = (input) => createTab(input);

    const ensurePage: WorkspaceTabs['ensurePage'] = async (tabName, startUrl) => {
        const existing = tabs.get(tabName);
        if (existing?.page && !existing.page.isClosed()) {
            return existing.page;
        }
        const page = await deps.getPage(tabName, startUrl);
        if (existing) {
            existing.page = page;
            existing.url = page.url();
            existing.updatedAt = now();
        } else {
            createTab({ tabName, page, url: page.url() });
        }
        return page;
    };

    const bindPage: WorkspaceTabs['bindPage'] = (tabName, page) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) { return null; }
        tab.page = page;
        tab.url = page.url();
        tab.updatedAt = now();
        return tab;
    };

    const closeTab: WorkspaceTabs['closeTab'] = async (tabName) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) { return null; }
        if (tab.page && !tab.page.isClosed()) {
            try {
                await tab.page.close({ runBeforeUnload: true });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                throw new Error(`failed to close tab page: ${tabName}: ${message}`);
            }
        }
        tabs.delete(tabName);
        if (activeTabName === tabName) {
            activeTabName = tabs.keys().next().value ?? null;
        }
        return tab;
    };

    const reportTab: WorkspaceTabs['reportTab'] = (tabName, input) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) { return null; }
        if (typeof input.url === 'string') { tab.url = input.url; }
        if (typeof input.title === 'string') { tab.title = input.title; }
        tab.updatedAt = input.at ?? now();
        return tab;
    };

    const pingTab: WorkspaceTabs['pingTab'] = (tabName, input) => {
        const tab = tabs.get(tabName) || null;
        if (!tab) { return null; }
        if (typeof input.url === 'string') { tab.url = input.url; }
        if (typeof input.title === 'string') { tab.title = input.title; }
        tab.updatedAt = input.at ?? now();
        return tab;
    };

    const reassignTab: WorkspaceTabs['reassignTab'] = (tabName, input) => {
        if (!tabs.has(tabName)) {
            createTab({ tabName, at: input.at });
        }
        activeTabName = tabName;
        return tabs.get(tabName)!;
    };

    return {
        createTab,
        createMetadataTab,
        ensurePage,
        bindPage,
        closeTab,
        listTabs: () => Array.from(tabs.values()),
        setActiveTab: (tabName) => {
            if (!tabs.has(tabName)) {
                throw new Error(`tab not found: ${tabName}`);
            }
            activeTabName = tabName;
        },
        getActiveTab: () => (activeTabName ? tabs.get(activeTabName) || null : null),
        hasTab: (tabName) => tabs.has(tabName),
        getTab: (tabName) => tabs.get(tabName) || null,
        resolveTab: (tabName) => {
            if (tabName) {
                const tab = tabs.get(tabName);
                if (!tab) { throw new Error(`tab not found: ${tabName}`); }
                return tab;
            }
            const active = activeTabName ? tabs.get(activeTabName) || null : null;
            if (!active) { throw new Error('active tab not found'); }
            return active;
        },
        updateTab: (tabName: string, patch: Partial<Pick<RuntimeTab, 'url' | 'title' | 'updatedAt'>>) => {
            const tab = tabs.get(tabName) || null;
            if (!tab) { return null; }
            if (typeof patch.url === 'string') { tab.url = patch.url; }
            if (typeof patch.title === 'string') { tab.title = patch.title; }
            tab.updatedAt = patch.updatedAt ?? now();
            return tab;
        },
        reportTab,
        pingTab,
        reassignTab,
    };
};

export type TabsControl = {
    handle: (input: WorkspaceRouterInput) => Promise<ControlPlaneResult>;
};

const requireTabName = (payload: Record<string, unknown>): string => {
    const tabName = typeof payload.tabName === 'string' ? payload.tabName.trim() : '';
    if (!tabName) {
        throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'tabName is required');
    }
    return tabName;
};

export const createTabsControl = (): TabsControl => ({
    handle: async (input) => {
        const { action, workspace } = input;
        const payload = (action.payload ?? {}) as Record<string, unknown>;

        switch (action.type) {
            case 'tab.list': {
                const active = workspace.tabs.getActiveTab()?.name;
                return {
                    reply: replyAction(action, {
                        workspaceName: workspace.name,
                        tabs: workspace.tabs.listTabs().map((tab) => ({
                            tabName: tab.name,
                            url: tab.url,
                            title: tab.title,
                            active: active === tab.name,
                            createdAt: tab.createdAt,
                            updatedAt: tab.updatedAt,
                        })),
                    }),
                    events: [],
                };
            }

            case 'tab.create': {
                const tabName = crypto.randomUUID();
                const startUrl = typeof payload.startUrl === 'string' ? payload.startUrl : undefined;
                await workspace.tabs.ensurePage(tabName, startUrl);
                workspace.tabs.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            case 'tab.close': {
                const tabName = requireTabName(payload);
                await workspace.tabs.closeTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            case 'tab.setActive': {
                const tabName = requireTabName(payload);
                workspace.tabs.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName }), events: [] };
            }

            case 'tab.opened': {
                const tabName = requireTabName(payload);
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : '';
                const title = typeof payload.title === 'string' ? payload.title : '';
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!workspace.tabs.hasTab(tabName)) {
                    workspace.tabs.createMetadataTab({ tabName, url, title, at });
                } else {
                    workspace.tabs.updateTab(tabName, { url, title, updatedAt: at });
                }
                workspace.tabs.setActiveTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source }), events: [] };
            }

            case 'tab.report': {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : undefined;
                const title = typeof payload.title === 'string' ? payload.title : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName || !workspace.tabs.hasTab(tabName)) {
                    return { reply: replyAction(action, { source, reportedUrl: url, reportedTitle: title, reportedAt: at, stale: true }), events: [] };
                }
                workspace.tabs.reportTab(tabName, { url, title, at });
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedUrl: url, reportedTitle: title, reportedAt: at }), events: [] };
            }

            case 'tab.closed': {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName) {
                    return { reply: replyAction(action, { source, reportedAt: at }), events: [] };
                }
                await workspace.tabs.closeTab(tabName);
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedAt: at }), events: [] };
            }

            case 'tab.ping': {
                const tabName = typeof payload.tabName === 'string' ? payload.tabName : '';
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const url = typeof payload.url === 'string' ? payload.url : undefined;
                const title = typeof payload.title === 'string' ? payload.title : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                if (!tabName || !workspace.tabs.hasTab(tabName)) {
                    return { reply: replyAction(action, { source, reportedAt: at, stale: true }), events: [] };
                }
                workspace.tabs.pingTab(tabName, { url, title, at });
                return { reply: replyAction(action, { workspaceName: workspace.name, tabName, source, reportedUrl: url, reportedTitle: title, reportedAt: at }), events: [] };
            }

            case 'tab.reassign': {
                const tabName = requireTabName(payload);
                const source = typeof payload.source === 'string' ? payload.source : 'unknown';
                const windowId = typeof payload.windowId === 'number' ? payload.windowId : undefined;
                const at = typeof payload.at === 'number' ? payload.at : undefined;
                workspace.tabs.reassignTab(tabName, { at });
                return {
                    reply: replyAction(action, {
                        workspaceName: workspace.name,
                        tabName,
                        source,
                        windowId,
                        reportedAt: at,
                    }),
                    events: [],
                };
            }

            case 'tab.activated': {
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported action: ${action.type}`);
            }

            default:
                throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, `unsupported tab action: ${action.type}`);
        }
    },
});
