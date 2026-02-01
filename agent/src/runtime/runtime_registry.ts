/**
 * RuntimeRegistry：统一 workspace/tab/page 与 Trace 的绑定入口。
 *
 * 设计目标：
 * - 以 workspaceId 为路由单位，确保每次执行能找到“当前 active page”
 * - Page 绑定时自动创建 trace tools，并在日志中携带标签（workspaceId/tabToken）
 * - 不在此层做动作执行，只负责“运行时资源与绑定关系”
 */

import type { Page } from 'playwright';
import type { PageRegistry, WorkspaceId } from './page_registry';
import { createTraceTools, type BrowserAutomationTools } from '../runner/trace';
import type { TraceContext, TraceHooks, TraceSink } from '../runner/trace/types';

export type PageBinding = {
    workspaceId: WorkspaceId;
    tabId: string;
    tabToken: string;
    page: Page;
    traceTools: BrowserAutomationTools;
    traceCtx: TraceContext;
};

export type RuntimeRegistry = {
    ensureActivePage: (workspaceId: WorkspaceId) => Promise<PageBinding>;
    bindPage: (page: Page, tabToken: string) => PageBinding;
    getBindingByTabToken: (tabToken: string) => PageBinding | null;
    setActiveTab: (workspaceId: WorkspaceId, tabId: string) => void;
};

type RuntimeRegistryOptions = {
    pageRegistry: PageRegistry;
    traceHooks?: TraceHooks;
    traceSinks?: TraceSink[];
};

/**
 * 创建 RuntimeRegistry。内部维护 tabToken -> trace 绑定映射。
 * 当 Page 关闭时会自动清理对应绑定。
 */
export const createRuntimeRegistry = (options: RuntimeRegistryOptions): RuntimeRegistry => {
    const bindings = new Map<string, PageBinding>();

    const bindPage = (page: Page, tabToken: string): PageBinding => {
        const scope = options.pageRegistry.resolveScopeFromToken(tabToken);
        const existing = bindings.get(tabToken);
        if (existing && existing.page === page) {
            return existing;
        }
        const { tools, ctx } = createTraceTools({
            page,
            context: page.context(),
            sinks: options.traceSinks,
            hooks: options.traceHooks,
            tags: { workspaceId: scope.workspaceId, tabToken },
        });
        const binding: PageBinding = {
            workspaceId: scope.workspaceId,
            tabId: scope.tabId,
            tabToken,
            page,
            traceTools: tools,
            traceCtx: ctx,
        };
        bindings.set(tabToken, binding);
        page.on('close', () => {
            bindings.delete(tabToken);
        });
        return binding;
    };

    /**
     * 确保 workspace 有可用页面：
     * - 若 workspace 不存在则创建
     * - 若没有 active tab 则自动创建新 tab
     * - 返回绑定了 trace 的 PageBinding
     */
    const ensureActivePage = async (workspaceId: WorkspaceId) => {
        const workspace = options.pageRegistry.listWorkspaces().find((w) => w.workspaceId === workspaceId);
        if (!workspace) {
            const created = await options.pageRegistry.createWorkspace();
            workspaceId = created.workspaceId;
        }
        const resolved = options.pageRegistry.resolveScope({ workspaceId });
        const page = await options.pageRegistry.resolvePage({ workspaceId, tabId: resolved.tabId });
        const tabToken = options.pageRegistry.resolveTabToken({ workspaceId, tabId: resolved.tabId });
        return bindPage(page, tabToken);
    };

    const getBindingByTabToken = (tabToken: string) => bindings.get(tabToken) || null;

    const setActiveTab = (workspaceId: WorkspaceId, tabId: string) => {
        options.pageRegistry.setActiveTab(workspaceId, tabId);
    };

    return {
        ensureActivePage,
        bindPage,
        getBindingByTabToken,
        setActiveTab,
    };
};
