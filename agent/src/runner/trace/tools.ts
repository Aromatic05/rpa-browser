/**
 * Trace tools：绑定 Page/Context，提供原子操作函数集合。
 *
 * 设计说明：
 * - 统一通过 traceCall 记录 op.start/op.end
 * - 本层不做高阶策略，仅调用 Playwright 原语
 * - A11y snapshot 结果会进入 cache，供 adoptA11yNode 使用
 */

import type { BrowserContext, Locator, Page } from 'playwright';
import type {
    ConsoleEntry,
    NetworkEntry,
    ToolResult,
    TraceContext,
    TraceHooks,
    TraceOpName,
    TraceSink,
    TraceTags,
} from './types';
import type { A11yCandidate } from './a11y/find';
import type { PageRegistry, WorkspaceId } from '../../runtime/page_registry';
import { traceCall } from './trace_call';
import { createLoggingHooks } from './hooks';
import { getA11yTree } from './a11y/getA11yTree';
import { createTabsTools } from './tools/tabs';
import { createPageTools } from './tools/page';
import { createLocatorTools } from './tools/locator';

export type TraceLocatorTarget = {
    a11yNodeId?: string;
    selector?: string;
    role?: string;
    name?: string;
};

type TraceA11yHint = {
    role?: string;
    name?: string;
    text?: string;
};

export type BrowserAutomationTools = {
    'trace.tabs.create': (args: { workspaceId: WorkspaceId; url?: string; timeout?: number }) => Promise<ToolResult<{ tabId: string }>>;
    'trace.tabs.switch': (args: { workspaceId: WorkspaceId; tabId: string }) => Promise<ToolResult>;
    'trace.tabs.close': (args: { workspaceId: WorkspaceId; tabId?: string }) => Promise<ToolResult>;
    'trace.page.goto': (args: { url: string; timeout?: number }) => Promise<ToolResult>;
    'trace.page.goBack': (args: { timeout?: number }) => Promise<ToolResult>;
    'trace.page.reload': (args: { timeout?: number }) => Promise<ToolResult>;
    'trace.page.getInfo': () => Promise<ToolResult<{ url: string; title: string; tabId?: string; tabs?: Array<{ tabId: string; url?: string; title?: string }> }>>;
    'trace.page.snapshotA11y': (args: { includeA11y: boolean; focusOnly: boolean }) => Promise<ToolResult<{ snapshotId: string; a11y?: string }>>;
    'trace.page.getContent': (args: { ref: string }) => Promise<ToolResult<{ ref: string; content: string }>>;
    'trace.page.readConsole': (args?: { limit?: number }) => Promise<ToolResult<ConsoleEntry[]>>;
    'trace.page.readNetwork': (args?: { limit?: number }) => Promise<ToolResult<NetworkEntry[]>>;
    'trace.page.evaluate': (args: { expression: string; arg?: unknown }) => Promise<ToolResult<unknown>>;
    'trace.page.screenshot': (args: { fullPage?: boolean } & TraceLocatorTarget) => Promise<ToolResult<string>>;
    'trace.page.scrollBy': (args: { direction: 'up' | 'down'; amount: number }) => Promise<ToolResult>;
    'trace.a11y.findByA11yHint': (args: { hint: TraceA11yHint }) => Promise<ToolResult<A11yCandidate[]>>;
    'trace.a11y.resolveByNodeId': (args: { a11yNodeId: string }) => Promise<ToolResult<{ a11yNodeId: string }>>;
    'trace.locator.waitForVisible': (args: TraceLocatorTarget & { timeout?: number }) => Promise<ToolResult>;
    'trace.locator.scrollIntoView': (args: TraceLocatorTarget) => Promise<ToolResult>;
    'trace.locator.click': (args: TraceLocatorTarget & { timeout?: number; button?: 'left' | 'right' | 'middle' }) => Promise<ToolResult>;
    'trace.locator.focus': (args: TraceLocatorTarget) => Promise<ToolResult>;
    'trace.locator.fill': (args: TraceLocatorTarget & { value: string }) => Promise<ToolResult>;
    'trace.locator.type': (args: TraceLocatorTarget & { text: string; delayMs?: number }) => Promise<ToolResult>;
    'trace.locator.selectOption': (
        args: TraceLocatorTarget & { values: string[]; timeout?: number },
    ) => Promise<ToolResult<{ selected: string[] }>>;
    'trace.locator.readSelectState': (
        args: TraceLocatorTarget,
    ) => Promise<ToolResult<{ selectedValues: string[]; selectedLabels: string[] }>>;
    'trace.locator.hover': (args: TraceLocatorTarget) => Promise<ToolResult>;
    'trace.locator.dragDrop': (args: { source: TraceLocatorTarget; dest?: TraceLocatorTarget; destCoord?: { x: number; y: number } }) => Promise<ToolResult>;
    'trace.page.scrollTo': (args: { x: number; y: number }) => Promise<ToolResult>;
    'trace.keyboard.press': (args: { key: string }) => Promise<ToolResult>;
    'trace.mouse.action': (
        args: {
            action: 'move' | 'down' | 'up' | 'wheel' | 'click' | 'dblclick';
            x: number;
            y: number;
            deltaY?: number;
            button?: 'left' | 'right' | 'middle';
        },
    ) => Promise<ToolResult>;
};

export const createTraceContext = (opts: {
    sinks?: TraceSink[];
    hooks?: TraceHooks;
    tags?: TraceTags;
}): TraceContext => ({
    sinks: opts.sinks || [],
    // 默认启用日志 hooks，便于 demo/人工验收；调用方可显式覆盖为 noop
    hooks: opts.hooks || createLoggingHooks(),
    cache: {},
    tags: opts.tags,
});

export const createTraceTools = (opts: {
    page: Page;
    context?: BrowserContext;
    pageRegistry?: PageRegistry;
    workspaceId?: WorkspaceId;
    sinks?: TraceSink[];
    hooks?: TraceHooks;
    tags?: TraceTags;
}): { tools: BrowserAutomationTools; ctx: TraceContext } => {
    const ctx = createTraceContext({ sinks: opts.sinks, hooks: opts.hooks, tags: opts.tags });
    let currentPage = opts.page;

    const run = <T,>(op: TraceOpName, args: unknown, fn: () => Promise<T>) =>
        traceCall(ctx, { op, args }, fn);

    const ensureA11yCache = async () => {
        if (!ctx.cache.a11yTree) {
            await getA11yTree(currentPage, ctx.cache);
        }
    };

    const resolveSelectorLocator = async (selector: string): Promise<Locator> => {
        const locator = currentPage.locator(selector);
        const count = await locator.count();
        if (count === 0) {
            throw { code: 'ERR_NOT_FOUND', message: 'selector not found', phase: 'trace', details: { selector } };
        }
        if (count > 1) {
            // TODO: add fuzzy disambiguation.
            throw { code: 'ERR_AMBIGUOUS', message: 'selector matches multiple elements', phase: 'trace', details: { selector, count } };
        }
        return locator;
    };

    const base = {
        opts: {
            pageRegistry: opts.pageRegistry,
            workspaceId: opts.workspaceId,
        },
        ctx,
        getCurrentPage: () => currentPage,
        setCurrentPage: (page: Page) => {
            currentPage = page;
        },
        run,
        ensureA11yCache,
        resolveSelectorLocator,
    };

    const tools: BrowserAutomationTools = {
        ...createTabsTools(base),
        ...createPageTools(base),
        ...createLocatorTools(base),
    };

    return { tools, ctx };
};
