import type { BrowserContext, Page } from 'playwright';
import crypto from 'crypto';
import { getLogger } from '../logging/logger';

export type WorkspaceName = string;
export type TabName = string;

export type Tab = {
    tabId: TabName;
    tabName: string;
    page: Page;
    createdAt: number;
    updatedAt: number;
};

export type Workspace = {
    workspaceName: WorkspaceName;
    tabs: Map<TabName, Tab>;
    activeTabName?: TabName;
    createdAt: number;
    updatedAt: number;
};

export type WorkspaceBinding = {
    workspaceName?: WorkspaceName;
    tabId?: TabName;
};

export type PageRegistryOptions = {
    tabNameKey: string;
    getContext: () => Promise<BrowserContext>;
    onPageBound?: (page: Page, token: string) => void;
    onTokenClosed?: (token: string) => void;
};

export type PageRegistry = {
    bindPage: (page: Page, hintedToken?: string) => Promise<string | null>;
    getPage: (tabName: string, urlHint?: string) => Promise<Page>;
    createWorkspace: () => Promise<{ workspaceName: WorkspaceName; tabId: TabName }>;
    createWorkspaceShell: (workspaceName?: WorkspaceName) => { workspaceName: WorkspaceName };
    listWorkspaces: () => Array<
        Pick<Workspace, 'workspaceName' | 'activeTabName' | 'createdAt' | 'updatedAt'> & { tabCount: number }
    >;
    setActiveWorkspace: (workspaceName: WorkspaceName) => void;
    getActiveWorkspace: () => Workspace | null;
    createTab: (workspaceName: WorkspaceName) => Promise<TabName>;
    closeTab: (workspaceName: WorkspaceName, tabId: TabName) => Promise<void>;
    setActiveTab: (workspaceName: WorkspaceName, tabId: TabName) => void;
    listTabs: (
        workspaceName: WorkspaceName,
    ) => Promise<Array<Pick<Tab, 'tabId' | 'createdAt' | 'updatedAt'> & { url: string; title: string; active: boolean }>>;
    resolvePage: (scope?: WorkspaceBinding) => Promise<Page>;
    resolveScope: (scope?: WorkspaceBinding) => { workspaceName: WorkspaceName; tabId: TabName };
    resolveTabBinding: (tabName: string) => { workspaceName: WorkspaceName; tabId: TabName };
    resolveTabName: (scope?: WorkspaceBinding) => string;
    touchTabToken: (tabName: string, at?: number) => { workspaceName: WorkspaceName; tabId: TabName } | null;
    bindTokenToWorkspace: (
        tabName: string,
        workspaceName: WorkspaceName,
    ) => { workspaceName: WorkspaceName; tabId: TabName } | null;
    moveTokenToWorkspace: (tabName: string, workspaceName: WorkspaceName) => { workspaceName: WorkspaceName; tabId: TabName } | null;
    rebindTokenToTab: (tabName: string, workspaceName: WorkspaceName, tabId: TabName) => { workspaceName: WorkspaceName; tabId: TabName } | null;
    listTimedOutTokens: (
        timeoutMs: number,
        now?: number,
    ) => Array<{ tabName: string; workspaceName: WorkspaceName; tabId: TabName; lastSeenAt: number }>;
    closeTokenPage: (tabName: string) => Promise<void>;
    createPendingTokenClaim: (claim: {
        tabName: string;
        workspaceName?: string;
        source?: string;
        url?: string;
        createdAt?: number;
    }) => void;
    claimPendingToken: (tabName: string) => Promise<{ workspaceName: WorkspaceName; tabId: TabName } | null>;
};

type PendingTokenClaim = {
    tabName: string;
    workspaceName?: string;
    source?: string;
    url?: string;
    createdAt: number;
};

const randomId = () => crypto.randomUUID();

export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const actionLog = getLogger('action');
    const log = (...args: unknown[]) => { actionLog.info('[RPA:page_registry]', ...args); };
    const logDebug = (...args: unknown[]) => { actionLog.debug('[RPA:page_registry]', ...args); };
    const logWarning = (...args: unknown[]) => { actionLog.warning('[RPA:page_registry]', ...args); };
    const logError = (...args: unknown[]) => { actionLog.error('[RPA:page_registry]', ...args); };
    const tokenToPage = new Map<string, Page>();
    const tokenToTab = new Map<string, { workspaceName: WorkspaceName; tabId: TabName }>();
    const pendingTokenClaims = new Map<string, PendingTokenClaim>();
    const workspaces = new Map<WorkspaceName, Workspace>();
    let activeWorkspaceName: WorkspaceName | null = null;

    const touchWorkspace = (workspace: Workspace) => {
        workspace.updatedAt = Date.now();
    };
    const removeTabRef = (workspaceName: WorkspaceName, tabId: TabName) => {
        const ws = workspaces.get(workspaceName);
        if (!ws) {return;}
        ws.tabs.delete(tabId);
        if (ws.activeTabName === tabId) {
            ws.activeTabName = ws.tabs.keys().next().value;
        }
        if (ws.tabs.size === 0) {
            workspaces.delete(workspaceName);
            if (activeWorkspaceName === workspaceName) {
                activeWorkspaceName = workspaces.keys().next().value || null;
            }
            return;
        }
        touchWorkspace(ws);
    };

    const getActiveWorkspace = () => (activeWorkspaceName ? workspaces.get(activeWorkspaceName) || null : null);

    const attachTokenToRuntime = (tabName: string, page: Page) => {
        tokenToPage.set(tabName, page);
        page.on('close', () => {
            if (tokenToPage.get(tabName) !== page) {return;}
            tokenToPage.delete(tabName);
            const ref = tokenToTab.get(tabName);
            tokenToTab.delete(tabName);
            if (ref) {
                removeTabRef(ref.workspaceName, ref.tabId);
            }
            options.onTokenClosed?.(tabName);
            log('bind_page.closed', { token: tabName, pageUrl: page.url() });
        });
    };

    const waitForToken = async (page: Page, attempts = 20, delayMs = 200) => {
        for (let i = 0; i < attempts; i += 1) {
            if (page.isClosed()) {return null;}
            try {
                const token = await page.evaluate((key) => sessionStorage.getItem(key), options.tabNameKey);
                if (token) {return token;}
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

    const installTokenToPage = async (page: Page, tabName: string) => {
        const script = `
            try { sessionStorage.setItem(${JSON.stringify(options.tabNameKey)}, ${JSON.stringify(tabName)}); } catch {}
            try { window.__rpa_tab_token = ${JSON.stringify(tabName)}; window.__TAB_TOKEN__ = ${JSON.stringify(tabName)}; } catch {}
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
                { token: tabName, key: options.tabNameKey },
            );
        } catch {
            // ignore
        }
    };

    const addTabRecord = (workspace: Workspace, tabId: TabName, tabName: string, page: Page) => {
        workspace.tabs.set(tabId, {
            tabId,
            tabName,
            page,
            createdAt: Date.now(),
            updatedAt: Date.now(),
        });
        if (!workspace.activeTabName) {workspace.activeTabName = tabId;}
        tokenToTab.set(tabName, { workspaceName: workspace.workspaceName, tabId });
        touchWorkspace(workspace);
        log('attach_tab', { workspaceName: workspace.workspaceName, tabId, tabName, pageUrl: page.url() });
    };

    const attachTokenToWorkspace = (workspace: Workspace, tabName: string, page: Page) => {
        const tabId = randomId();
        addTabRecord(workspace, tabId, tabName, page);
        workspace.activeTabName = tabId;
        touchWorkspace(workspace);
        return { workspaceName: workspace.workspaceName, tabId };
    };

    const moveTokenToWorkspace = (tabName: string, workspaceName: WorkspaceName) => {
        const ref = tokenToTab.get(tabName);
        if (!ref) {return null;}
        if (ref.workspaceName === workspaceName) {return { workspaceName, tabId: ref.tabId };}

        const sourceWorkspace = workspaces.get(ref.workspaceName);
        const sourceTab = sourceWorkspace?.tabs.get(ref.tabId);
        const targetWorkspace = workspaces.get(workspaceName);
        if (!sourceWorkspace || !sourceTab || !targetWorkspace) {return null;}

        sourceWorkspace.tabs.delete(ref.tabId);
        if (sourceWorkspace.activeTabName === ref.tabId) {
            sourceWorkspace.activeTabName = sourceWorkspace.tabs.keys().next().value;
        }
        if (sourceWorkspace.tabs.size === 0) {
            workspaces.delete(sourceWorkspace.workspaceName);
            if (activeWorkspaceName === sourceWorkspace.workspaceName) {
                activeWorkspaceName = workspaceName;
            }
        } else {
            touchWorkspace(sourceWorkspace);
        }

        const nextTabName = randomId();
        targetWorkspace.tabs.set(nextTabName, {
            ...sourceTab,
            tabId: nextTabName,
            updatedAt: Date.now(),
        });
        targetWorkspace.activeTabName = nextTabName;
        touchWorkspace(targetWorkspace);
        tokenToTab.set(tabName, { workspaceName, tabId: nextTabName });
        return { workspaceName, tabId: nextTabName };
    };

    const createWorkspaceInternal = (tabName: string, page: Page, forcedWorkspaceName?: WorkspaceName) => {
        const workspaceName = forcedWorkspaceName || randomId();
        if (workspaces.has(workspaceName)) {
            throw new Error(`workspace already exists: ${workspaceName}`);
        }
        const tabId = randomId();
        const now = Date.now();
        const workspace: Workspace = {
            workspaceName,
            tabs: new Map(),
            activeTabName: tabId,
            createdAt: now,
            updatedAt: now,
        };
        addTabRecord(workspace, tabId, tabName, page);
        workspaces.set(workspaceName, workspace);
        activeWorkspaceName = workspaceName;
        log('create_workspace_internal', { workspaceName, tabId, tabName, pageUrl: page.url() });
        return { workspaceName, tabId };
    };

    const bindPage = async (page: Page, hintedToken?: string) => {
        try {
            if (page.isClosed()) {return null;}
            const token = hintedToken || (await waitForToken(page));
            if (!token) {return null;}

            log('bind_page.start', { hintedToken: hintedToken || null, resolvedToken: token, pageUrl: page.url() });
            attachTokenToRuntime(token, page);
            if (!tokenToTab.has(token)) {
                const pending = pendingTokenClaims.get(token);
                if (pending) {
                    const targetWorkspaceName = pending.workspaceName || activeWorkspaceName || createWorkspaceShell().workspaceName;
                    createWorkspaceShell(targetWorkspaceName);
                    const attached = bindTokenToWorkspace(token, targetWorkspaceName);
                    if (attached) {
                        pendingTokenClaims.delete(token);
                        log('bind_page.claimed_pending_token', {
                            token,
                            pageUrl: page.url(),
                            workspaceName: attached.workspaceName,
                            tabId: attached.tabId,
                            source: pending.source || 'unknown',
                        });
                    } else {
                        logWarning('bind_page.pending_claim_failed', {
                            token,
                            pageUrl: page.url(),
                            workspaceName: targetWorkspaceName,
                            source: pending.source || 'unknown',
                        });
                    }
                } else {
                    const active = getActiveWorkspace();
                    if (active?.tabs.size === 0) {
                        const attached = attachTokenToWorkspace(active, token, page);
                        activeWorkspaceName = active.workspaceName;
                        log('bind_page.auto_bound_shell_workspace', {
                            token,
                            pageUrl: page.url(),
                            workspaceName: attached.workspaceName,
                            tabId: attached.tabId,
                        });
                    } else {
                        logWarning('bind_page.unbound', { token, pageUrl: page.url() });
                    }
                }
            } else {
                const ref = tokenToTab.get(token)!;
                const tab = workspaces.get(ref.workspaceName)?.tabs.get(ref.tabId);
                if (tab) {
                    tab.page = page;
                    tab.updatedAt = Date.now();
                    const ws = workspaces.get(ref.workspaceName);
                    if (ws) {touchWorkspace(ws);}
                }
            }
            options.onPageBound?.(page, token);
            log('bind_page.done', { token, pageUrl: page.url() });
            return token;
        } catch {
            logError('bind_page.error', { hintedToken: hintedToken || null, pageUrl: page.url() });
            return null;
        }
    };

    const openPageWithToken = async (tabName: string, opts?: { newWindow?: boolean }) => {
        const context = await options.getContext();
        let page: Page;
        if (opts?.newWindow) {
            const pagesBefore = new Set(context.pages());
            const waitNewPage = context.waitForEvent('page', {
                timeout: 10000,
                predicate: (next) => !pagesBefore.has(next),
            });
            const browser = context.browser();
            if (!browser) {
                throw new Error('browser handle unavailable for new window creation');
            }
            const cdp = await browser.newBrowserCDPSession();
            await cdp.send('Target.createTarget', { url: 'chrome://newtab/', newWindow: true, background: false });
            await cdp.detach().catch(() => {});
            page = await waitNewPage;
        } else {
            page = await context.newPage();
        }
        await installTokenToPage(page, tabName);
        return page;
    };

    const rebuildTokenMap = async () => {
        const context = await options.getContext();
        const pages = context.pages();
        logDebug('rebuild_token_map.start', { pageCount: pages.length });
        for (const page of pages) {
            const token = await waitForToken(page, 3, 100);
            if (!token) {continue;}
            attachTokenToRuntime(token, page);
            logDebug('rebuild_token_map.bound', { token, pageUrl: page.url() });
        }
    };

    const getPage = async (tabName: string, urlHint?: string) => {
        if (!tabName) {throw new Error('missing tabName');}
        logDebug('get_page.start', { tabName, urlHint: urlHint || null });

        let page = tokenToPage.get(tabName);
        if (page && !page.isClosed()) {return page;}

        await rebuildTokenMap();
        page = tokenToPage.get(tabName);
        if (page && !page.isClosed()) {return page;}

        page = await openPageWithToken(tabName);
        if (urlHint) {
            await page.goto(urlHint, { waitUntil: 'domcontentloaded' });
        }
        await bindPage(page, tabName);
        logDebug('get_page.done', { tabName, finalUrl: page.url() });
        return page;
    };

    const resolveScope = (scope?: WorkspaceBinding) => {
        const workspace = scope?.workspaceName ? workspaces.get(scope.workspaceName) : getActiveWorkspace();
        if (!workspace) {throw new Error('workspace not found');}
        const tabId = scope?.tabId || workspace.activeTabName;
        if (!tabId || !workspace.tabs.has(tabId)) {throw new Error('tab not found');}
        return { workspaceName: workspace.workspaceName, tabId };
    };

    const resolveTabName = (scope?: WorkspaceBinding) => {
        const resolved = resolveScope(scope);
        const tab = workspaces.get(resolved.workspaceName)?.tabs.get(resolved.tabId);
        if (!tab) {throw new Error('tab not found');}
        return tab.tabName;
    };

    const resolvePage = async (scope?: WorkspaceBinding) => {
        const workspace = scope?.workspaceName ? workspaces.get(scope.workspaceName) : getActiveWorkspace();
        if (!workspace) {throw new Error('workspace not found');}
        const tabId = scope?.tabId || workspace.activeTabName;
        if (!tabId) {throw new Error('tab not found');}
        const tab = workspace.tabs.get(tabId);
        if (!tab) {throw new Error('tab not found');}
        return tab.page;
    };

    const createWorkspace = async () => {
        const tabName = randomId();
        const page = await openPageWithToken(tabName, { newWindow: true });
        const result = createWorkspaceInternal(tabName, page);
        await bindPage(page, tabName);
        return result;
    };

    const createWorkspaceShell = (workspaceName?: WorkspaceName) => {
        const id = workspaceName || randomId();
        if (workspaces.has(id)) {return { workspaceName: id };}
        const now = Date.now();
        workspaces.set(id, {
            workspaceName: id,
            tabs: new Map(),
            activeTabName: undefined,
            createdAt: now,
            updatedAt: now,
        });
        if (!activeWorkspaceName) {activeWorkspaceName = id;}
        return { workspaceName: id };
    };

    const createPendingTokenClaim = (claim: {
        tabName: string;
        workspaceName?: string;
        source?: string;
        url?: string;
        createdAt?: number;
    }) => {
        if (!claim.tabName) {return;}
        if (claim.workspaceName) {
            createWorkspaceShell(claim.workspaceName);
        }
        pendingTokenClaims.set(claim.tabName, {
            tabName: claim.tabName,
            workspaceName: claim.workspaceName,
            source: claim.source,
            url: claim.url,
            createdAt: claim.createdAt ?? Date.now(),
        });
    };

    const claimPendingToken = async (tabName: string): Promise<{ workspaceName: WorkspaceName; tabId: TabName } | null> => {
        if (!tabName) {return null;}
        const pending = pendingTokenClaims.get(tabName);
        if (!pending) {return null;}
        if (!tokenToPage.get(tabName)) {
            await rebuildTokenMap();
        }
        const page = tokenToPage.get(tabName);
        if (!page || page.isClosed()) {return null;}
        const targetWorkspaceName = pending.workspaceName || activeWorkspaceName || createWorkspaceShell().workspaceName;
        createWorkspaceShell(targetWorkspaceName);
        const attached = bindTokenToWorkspace(tabName, targetWorkspaceName);
        if (!attached) {return null;}
        pendingTokenClaims.delete(tabName);
        log('claim_pending_token.done', {
            tabName,
            workspaceName: attached.workspaceName,
            tabId: attached.tabId,
            source: pending.source || 'unknown',
        });
        return attached;
    };

    const createTab = async (workspaceName: WorkspaceName) => {
        const workspace = workspaces.get(workspaceName);
        if (!workspace) {throw new Error('workspace not found');}
        const tabName = randomId();
        const page = await openPageWithToken(tabName);
        const tabId = randomId();
        addTabRecord(workspace, tabId, tabName, page);
        workspace.activeTabName = tabId;
        touchWorkspace(workspace);
        await bindPage(page, tabName);
        return tabId;
    };

    const closeTab = async (workspaceName: WorkspaceName, tabId: TabName) => {
        const workspace = workspaces.get(workspaceName);
        if (!workspace) {return;}
        const tab = workspace.tabs.get(tabId);
        if (!tab) {return;}
        tokenToPage.delete(tab.tabName);
        tokenToTab.delete(tab.tabName);
        if (!tab.page.isClosed()) {
            await tab.page.close({ runBeforeUnload: true });
        }
        removeTabRef(workspaceName, tabId);
    };

    const setActiveWorkspace = (workspaceName: WorkspaceName) => {
        if (workspaces.has(workspaceName)) {activeWorkspaceName = workspaceName;}
    };

    const setActiveTab = (workspaceName: WorkspaceName, tabId: TabName) => {
        const workspace = workspaces.get(workspaceName);
        if (!workspace?.tabs.has(tabId)) {return;}
        workspace.activeTabName = tabId;
        touchWorkspace(workspace);
    };

    const listTabs = async (workspaceName: WorkspaceName) => {
        const workspace = workspaces.get(workspaceName);
        if (!workspace) {return [];}
        const tabs = Array.from(workspace.tabs.values());
        return await Promise.all(
            tabs.map(async (tab) => ({
                tabId: tab.tabId,
                url: tab.page.url(),
                title: await tab.page.title().catch(() => ''),
                active: workspace.activeTabName === tab.tabId,
                createdAt: tab.createdAt,
                updatedAt: tab.updatedAt,
            })),
        );
    };

    const listWorkspaces = () =>
        Array.from(workspaces.values()).map((workspace) => ({
            workspaceName: workspace.workspaceName,
            activeTabName: workspace.activeTabName,
            tabCount: workspace.tabs.size,
            createdAt: workspace.createdAt,
            updatedAt: workspace.updatedAt,
        }));

    const cleanupToken = (tabName: string) => {
        tokenToPage.delete(tabName);
        const ref = tokenToTab.get(tabName);
        if (ref) {removeTabRef(ref.workspaceName, ref.tabId);}
        tokenToTab.delete(tabName);
    };

    const resolveTabBinding = (tabName: string) => {
        const ref = tokenToTab.get(tabName);
        if (!ref) {
            logWarning('resolve_scope_from_token.miss', {
                tabName,
                knownTokenCount: tokenToTab.size,
                workspaceCount: workspaces.size,
                activeWorkspaceName,
            });
            throw new Error('workspace scope not found for tabName');
        }
        return { workspaceName: ref.workspaceName, tabId: ref.tabId };
    };

    const touchTabToken = (tabName: string, at?: number) => {
        const ref = tokenToTab.get(tabName);
        if (!ref) {return null;}
        const ws = workspaces.get(ref.workspaceName);
        const tab = ws?.tabs.get(ref.tabId);
        if (!ws || !tab) {return null;}
        tab.updatedAt = typeof at === 'number' ? at : Date.now();
        touchWorkspace(ws);
        return { workspaceName: ref.workspaceName, tabId: ref.tabId };
    };

    const bindTokenToWorkspace = (tabName: string, workspaceName: WorkspaceName) => {
        const existing = tokenToTab.get(tabName);
        if (existing) {return { workspaceName: existing.workspaceName, tabId: existing.tabId };}
        const page = tokenToPage.get(tabName);
        if (!page || page.isClosed()) {return null;}
        const workspace = workspaces.get(workspaceName);
        if (!workspace) {return null;}
        const attached = attachTokenToWorkspace(workspace, tabName, page);
        activeWorkspaceName = workspaceName;
        return attached;
    };

    const listTimedOutTokens = (timeoutMs: number, now = Date.now()) => {
        const timedOut: Array<{ tabName: string; workspaceName: WorkspaceName; tabId: TabName; lastSeenAt: number }> = [];
        for (const workspace of workspaces.values()) {
            for (const tab of workspace.tabs.values()) {
                if (now - tab.updatedAt <= timeoutMs) {continue;}
                timedOut.push({
                    tabName: tab.tabName,
                    workspaceName: workspace.workspaceName,
                    tabId: tab.tabId,
                    lastSeenAt: tab.updatedAt,
                });
            }
        }
        return timedOut;
    };

    const closeTokenPage = async (tabName: string) => {
        const page = tokenToPage.get(tabName);
        if (!page || page.isClosed()) {
            cleanupToken(tabName);
            return;
        }
        await page.close({ runBeforeUnload: true });
    };

    const rebindTokenToTab = (tabName: string, workspaceName: WorkspaceName, tabId: TabName) => {
        const workspace = workspaces.get(workspaceName);
        const tab = workspace?.tabs.get(tabId);
        if (!workspace || !tab) {return null;}

        const targetPrevToken = tab.tabName;
        if (targetPrevToken && targetPrevToken !== tabName) {
            tokenToTab.delete(targetPrevToken);
            tokenToPage.delete(targetPrevToken);
        }

        tokenToTab.set(tabName, { workspaceName, tabId });
        tokenToPage.set(tabName, tab.page);
        tab.tabName = tabName;
        tab.updatedAt = Date.now();
        workspace.activeTabName = tabId;
        touchWorkspace(workspace);
        log('rebind_token_to_tab', { tabName, workspaceName, tabId });
        return { workspaceName, tabId };
    };

    return {
        bindPage,
        getPage,
        createWorkspace,
        createWorkspaceShell,
        listWorkspaces,
        setActiveWorkspace,
        getActiveWorkspace,
        createTab,
        closeTab,
        setActiveTab,
        listTabs,
        resolvePage,
        resolveScope,
        resolveTabBinding,
        resolveTabName,
        touchTabToken,
        bindTokenToWorkspace,
        moveTokenToWorkspace,
        rebindTokenToTab,
        listTimedOutTokens,
        closeTokenPage,
        createPendingTokenClaim,
        claimPendingToken,
    };
};
