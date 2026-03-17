import type { BrowserContext, Page } from 'playwright';
import crypto from 'crypto';
import { getLogger } from '../logging/logger';

export type WorkspaceId = string;
export type TabId = string;

export type Tab = {
    tabId: TabId;
    tabToken: string;
    page: Page;
    createdAt: number;
    updatedAt: number;
};

export type Workspace = {
    workspaceId: WorkspaceId;
    tabs: Map<TabId, Tab>;
    activeTabId?: TabId;
    createdAt: number;
    updatedAt: number;
};

export type WorkspaceScope = {
    workspaceId?: WorkspaceId;
    tabId?: TabId;
};

export type PageRegistryOptions = {
    tabTokenKey: string;
    getContext: () => Promise<BrowserContext>;
    onPageBound?: (page: Page, token: string) => void;
    onTokenClosed?: (token: string) => void;
};

export type PageRegistry = {
    bindPage: (page: Page, hintedToken?: string) => Promise<string | null>;
    getPage: (tabToken: string, urlHint?: string) => Promise<Page>;
    createWorkspace: () => Promise<{ workspaceId: WorkspaceId; tabId: TabId }>;
    listWorkspaces: () => Array<
        Pick<Workspace, 'workspaceId' | 'activeTabId' | 'createdAt' | 'updatedAt'> & { tabCount: number }
    >;
    setActiveWorkspace: (workspaceId: WorkspaceId) => void;
    getActiveWorkspace: () => Workspace | null;
    createTab: (workspaceId: WorkspaceId) => Promise<TabId>;
    closeTab: (workspaceId: WorkspaceId, tabId: TabId) => Promise<void>;
    setActiveTab: (workspaceId: WorkspaceId, tabId: TabId) => void;
    listTabs: (
        workspaceId: WorkspaceId,
    ) => Promise<Array<Pick<Tab, 'tabId' | 'createdAt' | 'updatedAt'> & { url: string; title: string; active: boolean }>>;
    resolvePage: (scope?: WorkspaceScope) => Promise<Page>;
    resolveScope: (scope?: WorkspaceScope) => { workspaceId: WorkspaceId; tabId: TabId };
    resolveScopeFromToken: (tabToken: string) => { workspaceId: WorkspaceId; tabId: TabId };
    resolveTabToken: (scope?: WorkspaceScope) => string;
    touchTabToken: (tabToken: string, at?: number) => { workspaceId: WorkspaceId; tabId: TabId } | null;
    hasScopeForToken: (tabToken: string) => boolean;
    claimOrphanTokenToWorkspace: (
        tabToken: string,
        workspaceId: WorkspaceId,
    ) => { workspaceId: WorkspaceId; tabId: TabId } | null;
    claimWorkspaceForOrphanToken: (tabToken: string) => { workspaceId: WorkspaceId; tabId: TabId } | null;
    moveTokenToWorkspace: (tabToken: string, workspaceId: WorkspaceId) => { workspaceId: WorkspaceId; tabId: TabId } | null;
    getTokenPageUrl: (tabToken: string) => string | null;
    listTimedOutTokens: (
        timeoutMs: number,
        now?: number,
    ) => Array<{ tabToken: string; workspaceId: WorkspaceId; tabId: TabId; lastSeenAt: number }>;
    closeTokenPage: (tabToken: string) => Promise<void>;
};

const randomId = () => crypto.randomUUID();

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const actionLog = getLogger('action');
    const log = (...args: unknown[]) => actionLog('[RPA:page_registry]', ...args);
    const tokenToPage = new Map<string, Page>();
    const tokenToTab = new Map<string, { workspaceId: WorkspaceId; tabId: TabId }>();
    const workspaces = new Map<WorkspaceId, Workspace>();
    let activeWorkspaceId: WorkspaceId | null = null;

    const touchWorkspace = (workspace: Workspace) => {
        workspace.updatedAt = Date.now();
    };

    const getActiveWorkspace = () => (activeWorkspaceId ? workspaces.get(activeWorkspaceId) || null : null);

    const attachTokenToRuntime = (tabToken: string, page: Page) => {
        tokenToPage.set(tabToken, page);
        page.on('close', () => {
            if (tokenToPage.get(tabToken) !== page) return;
            tokenToPage.delete(tabToken);
            const ref = tokenToTab.get(tabToken);
            tokenToTab.delete(tabToken);
            if (ref) {
                const ws = workspaces.get(ref.workspaceId);
                if (ws) {
                    ws.tabs.delete(ref.tabId);
                    if (ws.activeTabId === ref.tabId) {
                        ws.activeTabId = ws.tabs.keys().next().value;
                    }
                    if (ws.tabs.size === 0) {
                        workspaces.delete(ref.workspaceId);
                        if (activeWorkspaceId === ref.workspaceId) {
                            activeWorkspaceId = workspaces.keys().next().value || null;
                        }
                    } else {
                        touchWorkspace(ws);
                    }
                }
            }
            options.onTokenClosed?.(tabToken);
            log('bind_page.closed', { token: tabToken, pageUrl: page.url() });
        });
    };

    const waitForToken = async (page: Page, attempts = 20, delayMs = 200) => {
        for (let i = 0; i < attempts; i += 1) {
            if (page.isClosed()) return null;
            try {
                const token = await page.evaluate((key) => sessionStorage.getItem(key), options.tabTokenKey);
                if (token) return token;
            } catch {
                // ignore
            }
            try {
                await page.waitForTimeout(delayMs);
            } catch {
                return null;
            }
        }
        return null;
    };

    const installTokenToPage = async (page: Page, tabToken: string) => {
        const script = `
            try { sessionStorage.setItem(${JSON.stringify(options.tabTokenKey)}, ${JSON.stringify(tabToken)}); } catch {}
            try { window.__rpa_tab_token = ${JSON.stringify(tabToken)}; window.__TAB_TOKEN__ = ${JSON.stringify(tabToken)}; } catch {}
        `;
        await page.addInitScript({ content: script });
        try {
            await page.evaluate(
                (args: { token: string; key: string }) => {
                    sessionStorage.setItem(args.key, args.token);
                    try {
                        (window as any).__rpa_tab_token = args.token;
                        (window as any).__TAB_TOKEN__ = args.token;
                    } catch {
                        // ignore
                    }
                },
                { token: tabToken, key: options.tabTokenKey },
            );
        } catch {
            // ignore
        }
    };

    const addTabRecord = (workspace: Workspace, tabId: TabId, tabToken: string, page: Page) => {
        workspace.tabs.set(tabId, {
            tabId,
            tabToken,
            page,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        if (!workspace.activeTabId) workspace.activeTabId = tabId;
        tokenToTab.set(tabToken, { workspaceId: workspace.workspaceId, tabId });
        touchWorkspace(workspace);
        log('attach_tab', { workspaceId: workspace.workspaceId, tabId, tabToken, pageUrl: page.url() });
    };

    const attachTokenToWorkspace = (workspace: Workspace, tabToken: string, page: Page) => {
        const tabId = randomId();
        addTabRecord(workspace, tabId, tabToken, page);
        workspace.activeTabId = tabId;
        touchWorkspace(workspace);
        return { workspaceId: workspace.workspaceId, tabId };
    };

    const moveTokenToWorkspace = (tabToken: string, workspaceId: WorkspaceId) => {
        const ref = tokenToTab.get(tabToken);
        if (!ref) return null;
        if (ref.workspaceId === workspaceId) return { workspaceId, tabId: ref.tabId };

        const sourceWorkspace = workspaces.get(ref.workspaceId);
        const sourceTab = sourceWorkspace?.tabs.get(ref.tabId);
        const targetWorkspace = workspaces.get(workspaceId);
        if (!sourceWorkspace || !sourceTab || !targetWorkspace) return null;

        sourceWorkspace.tabs.delete(ref.tabId);
        if (sourceWorkspace.activeTabId === ref.tabId) {
            sourceWorkspace.activeTabId = sourceWorkspace.tabs.keys().next().value;
        }
        if (sourceWorkspace.tabs.size === 0) {
            workspaces.delete(sourceWorkspace.workspaceId);
            if (activeWorkspaceId === sourceWorkspace.workspaceId) {
                activeWorkspaceId = workspaceId;
            }
        } else {
            touchWorkspace(sourceWorkspace);
        }

        const nextTabId = randomId();
        targetWorkspace.tabs.set(nextTabId, {
            ...sourceTab,
            tabId: nextTabId,
            updatedAt: Date.now(),
        });
        targetWorkspace.activeTabId = nextTabId;
        touchWorkspace(targetWorkspace);
        tokenToTab.set(tabToken, { workspaceId, tabId: nextTabId });
        return { workspaceId, tabId: nextTabId };
    };

    const createWorkspaceInternal = (tabToken: string, page: Page) => {
        const workspaceId = randomId();
        const tabId = randomId();
        const now = Date.now();
        const workspace: Workspace = {
            workspaceId,
            tabs: new Map(),
            activeTabId: tabId,
            createdAt: now,
            updatedAt: now,
        };
        addTabRecord(workspace, tabId, tabToken, page);
        workspaces.set(workspaceId, workspace);
        if (!activeWorkspaceId) activeWorkspaceId = workspaceId;
        log('create_workspace_internal', { workspaceId, tabId, tabToken, pageUrl: page.url() });
        return { workspaceId, tabId };
    };

    const bindPage = async (page: Page, hintedToken?: string) => {
        try {
            if (page.isClosed()) return null;
            const token = hintedToken || (await waitForToken(page));
            if (!token) return null;

            log('bind_page.start', { hintedToken: hintedToken || null, resolvedToken: token, pageUrl: page.url() });
            attachTokenToRuntime(token, page);
            if (!tokenToTab.has(token)) {
                log('bind_page.orphan', { token, pageUrl: page.url() });
            } else {
                const ref = tokenToTab.get(token)!;
                const tab = workspaces.get(ref.workspaceId)?.tabs.get(ref.tabId);
                if (tab) {
                    tab.page = page;
                    tab.updatedAt = Date.now();
                    const ws = workspaces.get(ref.workspaceId);
                    if (ws) touchWorkspace(ws);
                }
            }
            options.onPageBound?.(page, token);
            log('bind_page.done', { token, pageUrl: page.url() });
            return token;
        } catch {
            log('bind_page.error', { hintedToken: hintedToken || null, pageUrl: page.url() });
            return null;
        }
    };

    const openPageWithToken = async (tabToken: string) => {
        const context = await options.getContext();
        const page = await context.newPage();
        await installTokenToPage(page, tabToken);
        return page;
    };

    const rebuildTokenMap = async () => {
        const context = await options.getContext();
        const pages = context.pages();
        log('rebuild_token_map.start', { pageCount: pages.length });
        for (const page of pages) {
            const token = await waitForToken(page, 3, 100);
            if (!token) continue;
            attachTokenToRuntime(token, page);
            log('rebuild_token_map.bound', { token, pageUrl: page.url() });
        }
    };

    const getPage = async (tabToken: string, urlHint?: string) => {
        if (!tabToken) throw new Error('missing tabToken');
        log('get_page.start', { tabToken, urlHint: urlHint || null });

        let page = tokenToPage.get(tabToken);
        if (page && !page.isClosed()) return page;

        await rebuildTokenMap();
        page = tokenToPage.get(tabToken);
        if (page && !page.isClosed()) return page;

        page = await openPageWithToken(tabToken);
        if (urlHint) {
            await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
        }
        await bindPage(page, tabToken);
        log('get_page.done', { tabToken, finalUrl: page.url() });
        return page;
    };

    const resolveScope = (scope?: WorkspaceScope) => {
        const workspace = scope?.workspaceId ? workspaces.get(scope.workspaceId) : getActiveWorkspace();
        if (!workspace) throw new Error('workspace not found');
        const tabId = scope?.tabId || workspace.activeTabId;
        if (!tabId || !workspace.tabs.has(tabId)) throw new Error('tab not found');
        return { workspaceId: workspace.workspaceId, tabId };
    };

    const resolveTabToken = (scope?: WorkspaceScope) => {
        const resolved = resolveScope(scope);
        const tab = workspaces.get(resolved.workspaceId)?.tabs.get(resolved.tabId);
        if (!tab) throw new Error('tab not found');
        return tab.tabToken;
    };

    const resolvePage = async (scope?: WorkspaceScope) => {
        const workspace = scope?.workspaceId ? workspaces.get(scope.workspaceId) : getActiveWorkspace();
        if (!workspace) throw new Error('workspace not found');
        const tabId = scope?.tabId || workspace.activeTabId;
        if (!tabId) throw new Error('tab not found');
        const tab = workspace.tabs.get(tabId);
        if (!tab) throw new Error('tab not found');
        return tab.page;
    };

    const createWorkspace = async () => {
        const tabToken = randomId();
        const page = await openPageWithToken(tabToken);
        const result = createWorkspaceInternal(tabToken, page);
        await bindPage(page, tabToken);
        return result;
    };

    const createTab = async (workspaceId: WorkspaceId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) throw new Error('workspace not found');
        const tabToken = randomId();
        const page = await openPageWithToken(tabToken);
        const tabId = randomId();
        addTabRecord(workspace, tabId, tabToken, page);
        workspace.activeTabId = tabId;
        touchWorkspace(workspace);
        await bindPage(page, tabToken);
        return tabId;
    };

    const closeTab = async (workspaceId: WorkspaceId, tabId: TabId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return;
        const tab = workspace.tabs.get(tabId);
        if (!tab) return;
        workspace.tabs.delete(tabId);
        tokenToPage.delete(tab.tabToken);
        tokenToTab.delete(tab.tabToken);
        if (!tab.page.isClosed()) {
            await tab.page.close({ runBeforeUnload: true });
        }
        if (workspace.activeTabId === tabId) workspace.activeTabId = workspace.tabs.keys().next().value;
        touchWorkspace(workspace);
        if (workspace.tabs.size === 0) {
            workspaces.delete(workspaceId);
            if (activeWorkspaceId === workspaceId) {
                activeWorkspaceId = workspaces.keys().next().value || null;
            }
        }
    };

    const setActiveWorkspace = (workspaceId: WorkspaceId) => {
        if (workspaces.has(workspaceId)) activeWorkspaceId = workspaceId;
    };

    const setActiveTab = (workspaceId: WorkspaceId, tabId: TabId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace || !workspace.tabs.has(tabId)) return;
        workspace.activeTabId = tabId;
        touchWorkspace(workspace);
    };

    const listTabs = async (workspaceId: WorkspaceId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return [];
        const tabs = Array.from(workspace.tabs.values());
        return Promise.all(
            tabs.map(async (tab) => ({
                tabId: tab.tabId,
                url: tab.page.url(),
                title: await tab.page.title().catch(() => ''),
                active: workspace.activeTabId === tab.tabId,
                createdAt: tab.createdAt,
                updatedAt: tab.updatedAt,
            })),
        );
    };

    const listWorkspaces = () =>
        Array.from(workspaces.values()).map((workspace) => ({
            workspaceId: workspace.workspaceId,
            activeTabId: workspace.activeTabId,
            tabCount: workspace.tabs.size,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
        }));

    const cleanupToken = (tabToken: string) => {
        tokenToPage.delete(tabToken);
        const ref = tokenToTab.get(tabToken);
        if (ref) {
            const ws = workspaces.get(ref.workspaceId);
            if (ws) {
                ws.tabs.delete(ref.tabId);
                if (ws.activeTabId === ref.tabId) ws.activeTabId = ws.tabs.keys().next().value;
                if (ws.tabs.size === 0) {
                    workspaces.delete(ref.workspaceId);
                    if (activeWorkspaceId === ref.workspaceId) {
                        activeWorkspaceId = workspaces.keys().next().value || null;
                    }
                } else {
                    touchWorkspace(ws);
                }
            }
        }
        tokenToTab.delete(tabToken);
    };

    const resolveScopeFromToken = (tabToken: string) => {
        const ref = tokenToTab.get(tabToken);
        if (!ref) {
            log('resolve_scope_from_token.miss', {
                tabToken,
                knownTokenCount: tokenToTab.size,
                workspaceCount: workspaces.size,
                activeWorkspaceId,
            });
            throw new Error('workspace scope not found for tabToken');
        }
        return { workspaceId: ref.workspaceId, tabId: ref.tabId };
    };

    const touchTabToken = (tabToken: string, at?: number) => {
        const ref = tokenToTab.get(tabToken);
        if (!ref) return null;
        const ws = workspaces.get(ref.workspaceId);
        const tab = ws?.tabs.get(ref.tabId);
        if (!ws || !tab) return null;
        tab.updatedAt = typeof at === 'number' ? at : Date.now();
        touchWorkspace(ws);
        return { workspaceId: ref.workspaceId, tabId: ref.tabId };
    };

    const hasScopeForToken = (tabToken: string) => tokenToTab.has(tabToken);

    const claimOrphanTokenToWorkspace = (tabToken: string, workspaceId: WorkspaceId) => {
        const existing = tokenToTab.get(tabToken);
        if (existing) return { workspaceId: existing.workspaceId, tabId: existing.tabId };
        const page = tokenToPage.get(tabToken);
        if (!page || page.isClosed()) return null;
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return null;
        const attached = attachTokenToWorkspace(workspace, tabToken, page);
        activeWorkspaceId = workspaceId;
        return attached;
    };

    const claimWorkspaceForOrphanToken = (tabToken: string) => {
        const existing = tokenToTab.get(tabToken);
        if (existing) return { workspaceId: existing.workspaceId, tabId: existing.tabId };
        const page = tokenToPage.get(tabToken);
        if (!page || page.isClosed()) return null;
        const created = createWorkspaceInternal(tabToken, page);
        activeWorkspaceId = created.workspaceId;
        return created;
    };

    const getTokenPageUrl = (tabToken: string) => {
        const page = tokenToPage.get(tabToken);
        if (!page || page.isClosed()) return null;
        return page.url();
    };

    const listTimedOutTokens = (timeoutMs: number, now = Date.now()) => {
        const timedOut: Array<{ tabToken: string; workspaceId: WorkspaceId; tabId: TabId; lastSeenAt: number }> = [];
        for (const workspace of workspaces.values()) {
            for (const tab of workspace.tabs.values()) {
                if (now - tab.updatedAt <= timeoutMs) continue;
                timedOut.push({
                    tabToken: tab.tabToken,
                    workspaceId: workspace.workspaceId,
                    tabId: tab.tabId,
                    lastSeenAt: tab.updatedAt,
                });
            }
        }
        return timedOut;
    };

    const closeTokenPage = async (tabToken: string) => {
        const page = tokenToPage.get(tabToken);
        if (!page || page.isClosed()) {
            cleanupToken(tabToken);
            return;
        }
        await page.close({ runBeforeUnload: true });
    };

    return {
        bindPage,
        getPage,
        createWorkspace,
        listWorkspaces,
        setActiveWorkspace,
        getActiveWorkspace,
        createTab,
        closeTab,
        setActiveTab,
        listTabs,
        resolvePage,
        resolveScope,
        resolveScopeFromToken,
        resolveTabToken,
        touchTabToken,
        hasScopeForToken,
        claimOrphanTokenToWorkspace,
        claimWorkspaceForOrphanToken,
        moveTokenToWorkspace,
        getTokenPageUrl,
        listTimedOutTokens,
        closeTokenPage,
    };
};
