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
    ToolResult,
    TraceContext,
    TraceHooks,
    TraceOpName,
    TraceSink,
    TraceTags,
} from './types';
import type { A11yCandidate } from './a11y/find';
import type { A11yHint } from '../steps/types';
import type { PageRegistry, WorkspaceId } from '../../runtime/page_registry';
import { traceCall } from './trace_call';
import { createLoggingHooks } from './hooks';
import { getA11yTree } from './getA11yTree';
import { createTabsTools } from './tools/tabs';
import { createPageTools } from './tools/page';
import { createLocatorTools } from './tools/locator';

export type BrowserAutomationTools = {
    'trace.tabs.create': (args: { workspaceId: WorkspaceId; url?: string; timeout?: number }) => Promise<ToolResult<{ tabId: string }>>;
    'trace.tabs.switch': (args: { workspaceId: WorkspaceId; tabId: string }) => Promise<ToolResult<void>>;
    'trace.tabs.close': (args: { workspaceId: WorkspaceId; tabId?: string }) => Promise<ToolResult<void>>;
    'trace.page.goto': (args: { url: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.page.goBack': (args: { timeout?: number }) => Promise<ToolResult<void>>;
    'trace.page.reload': (args: { timeout?: number }) => Promise<ToolResult<void>>;
    'trace.page.getInfo': () => Promise<ToolResult<{ url: string; title: string; tabId?: string; tabs?: Array<{ tabId: string; url?: string; title?: string }> }>>;
    'trace.page.snapshotA11y': (args: { includeA11y: boolean; focusOnly: boolean }) => Promise<ToolResult<{ snapshotId: string; a11y?: string }>>;
    'trace.page.screenshot': (args: { fullPage?: boolean; a11yNodeId?: string }) => Promise<ToolResult<string>>;
    'trace.page.scrollBy': (args: { direction: 'up' | 'down'; amount: number }) => Promise<ToolResult<void>>;
    'trace.a11y.findByA11yHint': (args: { hint: A11yHint }) => Promise<ToolResult<A11yCandidate[]>>;
    'trace.a11y.resolveByNodeId': (args: { a11yNodeId: string }) => Promise<ToolResult<{ a11yNodeId: string }>>;
    'trace.locator.waitForVisible': (args: { a11yNodeId?: string; selector?: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.locator.scrollIntoView': (args: { a11yNodeId?: string; selector?: string }) => Promise<ToolResult<void>>;
    'trace.locator.click': (args: { a11yNodeId?: string; selector?: string; timeout?: number; button?: 'left' | 'right' | 'middle' }) => Promise<ToolResult<void>>;
    'trace.locator.focus': (args: { a11yNodeId?: string; selector?: string }) => Promise<ToolResult<void>>;
    'trace.locator.fill': (args: { a11yNodeId?: string; selector?: string; value: string }) => Promise<ToolResult<void>>;
    'trace.locator.type': (args: { a11yNodeId?: string; selector?: string; text: string; delayMs?: number }) => Promise<ToolResult<void>>;
    'trace.locator.selectOption': (
        args: { a11yNodeId?: string; selector?: string; values: string[]; timeout?: number },
    ) => Promise<ToolResult<{ selected: string[] }>>;
    'trace.locator.hover': (args: { a11yNodeId?: string; selector?: string }) => Promise<ToolResult<void>>;
    'trace.locator.dragDrop': (args: { sourceNodeId: string; destNodeId?: string; destCoord?: { x: number; y: number } }) => Promise<ToolResult<void>>;
    'trace.page.scrollTo': (args: { x: number; y: number }) => Promise<ToolResult<void>>;
    'trace.keyboard.press': (args: { key: string }) => Promise<ToolResult<void>>;
    'trace.mouse.action': (args: { action: 'move' | 'down' | 'up' | 'wheel'; x: number; y: number; deltaY?: number; button?: 'left' | 'right' | 'middle' }) => Promise<ToolResult<void>>;
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
