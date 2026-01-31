/**
 * PageRegistry：维护 tabToken 与 Playwright Page 的映射，并在此之上提供
 * workspace -> tabs 的抽象（对外暴露 workspaceId/tabId）。
 *
 * 依赖关系：
 * - 上游：agent/index.ts 通过 createPageRegistry 管理页面生命周期
 * - 下游：runner/execute 与 target_resolver 通过 resolvePage/resolveScope 获取 Page
 *
 * 关键约束：
 * - tabToken 是内部绑定键，不应对外暴露给 AI 或 UI
 * - workspace/tab 仅作为 UI/协议层的稳定标识，仍由 tabToken 驱动具体 Page
 * - Page 可能在浏览器事件中被关闭，需要容错与重建映射
 */
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
    resolveTabToken: (scope?: WorkspaceScope) => string;
};

const randomId = () => crypto.randomUUID();

/**
 * 创建 PageRegistry。负责：
 * - tabToken <-> Page 的绑定
 * - workspace/tab 的创建、切换、关闭
 * - scope 解析（workspaceId/tabId -> Page）
 */
export const createPageRegistry = (options: PageRegistryOptions): PageRegistry => {
    const tokenToPage = new Map<string, Page>();
    const tokenToTab = new Map<string, { workspaceId: WorkspaceId; tabId: TabId }>();
    const workspaces = new Map<WorkspaceId, Workspace>();
    let activeWorkspaceId: WorkspaceId | null = null;

    // 统一更新 workspace 的更新时间戳，便于 UI 层排序/高亮。
    const touchWorkspace = (workspace: Workspace) => {
        workspace.updatedAt = Date.now();
    };

    /**
     * 等待页面中写入 tabToken（content script 负责注入）。
     * 若页面尚未可执行脚本，则重试并容错。
     */
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

    /**
     * 将 tabToken 写入 sessionStorage，保障后续回连与重建映射。
     */
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

    /**
     * 在 workspace 内部建立 tabId -> tabToken -> Page 的映射。
     */
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

    /**
     * 内部创建 workspace，并用当前 page 作为首个 tab。
     * 对外只返回 workspaceId/tabId。
     */
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

    /**
     * 绑定 Page 与 tabToken，必要时创建新的 workspace。
     * 用于 context 的 page 事件，以及新页面的显式绑定。
     */
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

    /**
     * 当 tokenToPage 缓存失效时，尝试从当前 context 的 pages 重建映射。
     */
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

    /**
     * 根据 tabToken 获取 Page。若已关闭或不存在则新建并写入 token。
     */
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

    /**
     * 清理映射：可按 tabToken 精确清理，或全量清空。
     */
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

    /**
     * 创建新 workspace，并同时创建首个 tab。
     */
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

    /**
     * 设置 active workspace，仅在存在时生效。
     */
    const setActiveWorkspace = (workspaceId: WorkspaceId) => {
        if (workspaces.has(workspaceId)) {
            activeWorkspaceId = workspaceId;
        }
    };

    const getActiveWorkspace = () => (activeWorkspaceId ? workspaces.get(activeWorkspaceId) || null : null);

    /**
     * 在指定 workspace 内创建新 tab，并更新 activeTabId。
     */
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

    /**
     * 关闭 tab，并在必要时回收空 workspace。
     */
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
        if (workspace.tabs.size === 0) {
            workspaces.delete(workspaceId);
            if (activeWorkspaceId === workspaceId) {
                activeWorkspaceId = workspaces.keys().next().value || null;
            }
        }
    };

    const setActiveTab = (workspaceId: WorkspaceId, tabId: TabId) => {
        const workspace = workspaces.get(workspaceId);
        if (!workspace) return;
        if (!workspace.tabs.has(tabId)) return;
        workspace.activeTabId = tabId;
        touchWorkspace(workspace);
    };

    /**
     * 读取 workspace 内所有 tab 的可展示信息。
     */
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

    /**
     * 解析 scope（workspaceId/tabId），用于“只检查、不过度创建”的场景。
     */
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

    /**
     * 解析 scope 并返回 Page；若缺少 workspace/tab 则自动创建。
     * 该策略主要用于“默认作用于 active workspace/tab”的工具调用。
     */
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
        resolveTabToken: (scope?: WorkspaceScope) => {
            const resolved = resolveScope(scope);
            const workspace = workspaces.get(resolved.workspaceId);
            if (!workspace) throw new Error('workspace not found');
            const tab = workspace.tabs.get(resolved.tabId);
            if (!tab) throw new Error('tab not found');
            return tab.tabToken;
        },
    };
};
