import type { BrowserContext, Page } from 'playwright';
import crypto from 'crypto';

export type WorkspaceId = string;
export type TabId = string;

export type WorkspacePublicInfo = {
    workspaceId: WorkspaceId;
    activeTabId?: TabId;
    tabCount: number;
    groupId?: string;
    createdAt: number;
    updatedAt: number;
};

export type TabPublicInfo = {
    tabId: TabId;
    url: string;
    title: string;
    active: boolean;
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

type WorkspaceTab = {
    tabId: TabId;
    tabToken: string;
    page: Page;
    createdAt: number;
    updatedAt: number;
};

type Workspace = {
    id: WorkspaceId;
    tabs: Map<TabId, WorkspaceTab>;
    activeTabId?: TabId;
    groupId?: string;
    createdAt: number;
    updatedAt: number;
};

export type PageRegistry = {
    bindPage: (page: Page, hintedToken?: string) => Promise<string | null>;
    getPage: (tabToken: string, urlHint?: string) => Promise<Page>;
    listPages: () => Array<{ tabToken: string; page: Page }>;
    cleanup: (tabToken?: string) => void;
    createWorkspace: () => Promise<{ workspaceId: WorkspaceId; tabId: TabId }>;
    listWorkspaces: () => WorkspacePublicInfo[];
    setActiveWorkspace: (workspaceId: WorkspaceId) => void;
    getActiveWorkspace: () => Workspace | null;
    createTab: (workspaceId: WorkspaceId) => Promise<TabId>;
    closeTab: (workspaceId: WorkspaceId, tabId: TabId) => Promise<void>;
    setActiveTab: (workspaceId: WorkspaceId, tabId: TabId) => void;
    listTabs: (workspaceId: WorkspaceId) => Promise<TabPublicInfo[]>;
    resolvePage: (scope?: WorkspaceScope) => Promise<Page>;
    resolveScope: (scope?: WorkspaceScope) => { workspaceId: WorkspaceId; tabId: TabId };
    resolveScopeFromToken: (tabToken: string) => { workspaceId: WorkspaceId; tabId: TabId };
};

const randomId = () => crypto.randomUUID();

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const tokenToPage = new Map<string, Page>();
    const tokenToTab = new Map<string, { workspaceId: WorkspaceId; tabId: TabId }>();
    const workspaces = new Map<WorkspaceId, Workspace>();
    let activeWorkspaceId: WorkspaceId | null = null;

    const touchWorkspace = (workspace: Workspace) => {
        workspace.updatedAt = Date.now();
    };

    const waitForToken = async (page: Page, attempts = 20, delayMs = 200) => {
        for (let i = 0; i < attempts; i += 1) {
            if (page.isClosed()) return null;
            try {
                const token = await page.evaluate(
                    (key) => sessionStorage.getItem(key),
                    options.tabTokenKey,
                );
                if (token) return token;
            } catch {
                // ignore evaluation failures while page is loading
            }
            try {
                await page.waitForTimeout(delayMs);
            } catch {
                return null;
            }
        }
        return null;
    };

    const ensureTokenOnPage = async (page: Page, tabToken: string) => {
        try {
            await page.evaluate(
                (args: { token: string; key: string }) => {
                    sessionStorage.setItem(args.key, args.token);
                },
                { token: tabToken, key: options.tabTokenKey },
            );
        } catch {
            // ignore if sessionStorage is unavailable
        }
    };

    const attachTabToWorkspace = (
        workspace: Workspace,
        tabId: TabId,
        tabToken: string,
        page: Page,
    ) => {
        const tab: WorkspaceTab = {
            tabId,
            tabToken,
            page,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        };
        workspace.tabs.set(tabId, tab);
        workspace.activeTabId = workspace.activeTabId || tabId;
        touchWorkspace(workspace);
        tokenToPage.set(tabToken, page);
        tokenToTab.set(tabToken, { workspaceId: workspace.id, tabId });
    };

    const createWorkspaceInternal = (
        tabToken: string,
        page: Page,
    ): { workspaceId: WorkspaceId; tabId: TabId } => {
        const workspaceId = randomId();
        const tabId = randomId();
        const now = Date.now();
        const workspace: Workspace = {
            id: workspaceId,
            tabs: new Map(),
            activeTabId: tabId,
            createdAt: now,
            updatedAt: now,
        };
        attachTabToWorkspace(workspace, tabId, tabToken, page);
        workspaces.set(workspaceId, workspace);
        if (!activeWorkspaceId) activeWorkspaceId = workspaceId;
        return { workspaceId, tabId };
    };

    const bindPage = async (page: Page, hintedToken?: string) => {
        try {
            if (page.isClosed()) return null;
            const token = hintedToken || (await waitForToken(page));
            if (!token) return null;
            tokenToPage.set(token, page);
            if (!tokenToTab.has(token)) {
                createWorkspaceInternal(token, page);
            } else {
                const ref = tokenToTab.get(token);
                if (ref) {
                    const workspace = workspaces.get(ref.workspaceId);
                    const tab = workspace?.tabs.get(ref.tabId);
                    if (workspace && tab) {
                        tab.page = page;
                        tab.updatedAt = Date.now();
                        touchWorkspace(workspace);
                    }
                }
            }
            console.log('[RPA:agent]', 'bind page', { tabToken: token, pageUrl: page.url() });
            page.on('close', () => {
                const current = tokenToPage.get(token);
                if (current === page) {
                    tokenToPage.delete(token);
                    tokenToTab.delete(token);
                    options.onTokenClosed?.(token);
                }
            });
            options.onPageBound?.(page, token);
            return token;
        } catch {
            return null;
        }
    };

    const rebuildTokenMap = async () => {
        const context = await options.getContext();
        const pages = context.pages();
        for (const page of pages) {
            const token = await waitForToken(page, 3, 100);
            if (token) {
                tokenToPage.set(token, page);
                if (!tokenToTab.has(token)) {
                    createWorkspaceInternal(token, page);
                }
            }
        }
    };

    const getPage = async (tabToken: string, urlHint?: string) => {
        if (!tabToken) {
            throw new Error('missing tabToken');
        }
        let page = tokenToPage.get(tabToken);
        if (page && !page.isClosed()) return page;

        await rebuildTokenMap();
        page = tokenToPage.get(tabToken);
        if (page && !page.isClosed()) return page;

        const context = await options.getContext();
        page = await context.newPage();
        const initContent = `sessionStorage.setItem(${JSON.stringify(
            options.tabTokenKey,
        )}, ${JSON.stringify(tabToken)});`;
        await page.addInitScript({ content: initContent });

        if (urlHint) {
            await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
        }

        await ensureTokenOnPage(page, tabToken);
        await bindPage(page, tabToken);
        return page;
    };

    const listPages = () =>
        Array.from(tokenToPage.entries()).map(([tabToken, page]) => ({ tabToken, page }));

    const cleanup = (tabToken?: string) => {
        if (!tabToken) {
            tokenToPage.clear();
            tokenToTab.clear();
            workspaces.clear();
            activeWorkspaceId = null;
            return;
        }
        tokenToPage.delete(tabToken);
        const ref = tokenToTab.get(tabToken);
        if (ref) {
            const workspace = workspaces.get(ref.workspaceId);
            if (workspace) {
                workspace.tabs.delete(ref.tabId);
                if (workspace.activeTabId === ref.tabId) {
                    workspace.activeTabId = workspace.tabs.keys().next().value;
                }
                touchWorkspace(workspace);
            }
        }
        tokenToTab.delete(tabToken);
    };

    const createWorkspace = async () => {
        const context = await options.getContext();
        const page = await context.newPage();
        const tabToken = randomId();
        await page.addInitScript({
            content: `sessionStorage.setItem(${JSON.stringify(options.tabTokenKey)}, ${JSON.stringify(tabToken)});`,
        });
        await ensureTokenOnPage(page, tabToken);
        const result = createWorkspaceInternal(tabToken, page);
        await bindPage(page, tabToken);
        return result;
    };

    const listWorkspaces = () =>
        Array.from(workspaces.values()).map((workspace) => ({
            workspaceId: workspace.id,
            activeTabId: workspace.activeTabId,
            tabCount: workspace.tabs.size,
            groupId: workspace.groupId,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
        }));

    const setActiveWorkspace = (workspaceId: WorkspaceId) => {
        if (workspaces.has(workspaceId)) {
            activeWorkspaceId = workspaceId;
        }
    };

    const getActiveWorkspace = () => (activeWorkspaceId ? workspaces.get(activeWorkspaceId) || null : null);

    const createTab = async (workspaceId: WorkspaceId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) {
            throw new Error('workspace not found');
        }
        const context = await options.getContext();
        const page = await context.newPage();
        const tabToken = randomId();
        await page.addInitScript({
            content: `sessionStorage.setItem(${JSON.stringify(options.tabTokenKey)}, ${JSON.stringify(tabToken)});`,
        });
        await ensureTokenOnPage(page, tabToken);
        const tabId = randomId();
        attachTabToWorkspace(workspace, tabId, tabToken, page);
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
        if (workspace.activeTabId === tabId) {
            workspace.activeTabId = workspace.tabs.keys().next().value;
        }
        touchWorkspace(workspace);
    };

    const setActiveTab = (workspaceId: WorkspaceId, tabId: TabId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return;
        if (!workspace.tabs.has(tabId)) return;
        workspace.activeTabId = tabId;
        touchWorkspace(workspace);
    };

    const listTabs = async (workspaceId: WorkspaceId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return [];
        const items: TabPublicInfo[] = [];
        for (const tab of workspace.tabs.values()) {
            items.push({
                tabId: tab.tabId,
                url: tab.page.url(),
                title: await tab.page.title().catch(() => ''),
                active: workspace.activeTabId === tab.tabId,
                createdAt: tab.createdAt,
                updatedAt: tab.updatedAt,
            });
        }
        return items;
    };

    const resolveScope = (scope?: WorkspaceScope) => {
        let workspace = scope?.workspaceId ? workspaces.get(scope.workspaceId) : getActiveWorkspace();
        if (!workspace) {
            throw new Error('workspace not found');
        }
        const tabId = scope?.tabId || workspace.activeTabId;
        if (!tabId || !workspace.tabs.has(tabId)) {
            throw new Error('tab not found');
        }
        return { workspaceId: workspace.id, tabId };
    };

    const resolvePage = async (scope?: WorkspaceScope) => {
        let workspace = scope?.workspaceId ? workspaces.get(scope.workspaceId) : getActiveWorkspace();
        if (!workspace) {
            const created = await createWorkspace();
            workspace = workspaces.get(created.workspaceId) || null;
        }
        if (!workspace) throw new Error('workspace not found');
        const tabId = scope?.tabId || workspace.activeTabId;
        if (!tabId) {
            const createdTabId = await createTab(workspace.id);
            return workspace.tabs.get(createdTabId)!.page;
        }
        const tab = workspace.tabs.get(tabId);
        if (!tab) throw new Error('tab not found');
        return tab.page;
    };

    return {
        bindPage,
        getPage,
        listPages,
        cleanup,
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
        resolveScopeFromToken: (tabToken: string) => {
            const ref = tokenToTab.get(tabToken);
            if (!ref) {
                throw new Error('workspace scope not found for tabToken');
            }
            return { workspaceId: ref.workspaceId, tabId: ref.tabId };
        },
    };
};
