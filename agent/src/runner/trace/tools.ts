/**
 * Trace tools：绑定 Page/Context，提供原子操作函数集合。
 *
 * 设计说明：
 * - 统一通过 traceCall 记录 op.start/op.end
 * - 本层不做高阶策略，仅调用 Playwright 原语
 * - A11y snapshot 结果会进入 cache，供 adoptA11yNode 使用
 */

import type { BrowserContext, Page } from 'playwright';
import type {
    ToolResult,
    TraceContext,
    TraceHooks,
    TraceSink,
    TraceOpName,
} from './types';
import { traceCall } from './trace_call';
import { cacheA11ySnapshot } from './a11y_adopt';
import { createNoopHooks } from './hooks';

export type BrowserAutomationTools = {
    'trace.context.newPage': () => Promise<ToolResult<void>>;
    'trace.page.close': () => Promise<ToolResult<void>>;
    'trace.page.goto': (args: { url: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.page.getInfo': () => Promise<ToolResult<{ url: string; title: string }>>;
    'trace.page.snapshotA11y': () => Promise<ToolResult<string>>;
    'trace.page.screenshot': (args: { fullPage?: boolean }) => Promise<ToolResult<string>>;
    'trace.locator.waitForVisible': (args: { a11yNodeId: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.locator.scrollIntoView': (args: { a11yNodeId: string }) => Promise<ToolResult<void>>;
    'trace.locator.click': (args: { a11yNodeId: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.locator.focus': (args: { a11yNodeId: string }) => Promise<ToolResult<void>>;
    'trace.locator.fill': (args: { a11yNodeId: string; value: string }) => Promise<ToolResult<void>>;
    'trace.mouse.click': (args: { x: number; y: number }) => Promise<ToolResult<void>>;
    'trace.page.scrollTo': (args: { x: number; y: number }) => Promise<ToolResult<void>>;
    'trace.keyboard.press': (args: { key: string }) => Promise<ToolResult<void>>;
};

export const createTraceContext = (opts: {
    sinks?: TraceSink[];
    hooks?: TraceHooks;
}): TraceContext => ({
    sinks: opts.sinks || [],
    hooks: opts.hooks || createNoopHooks(),
    cache: {},
});

export const createTraceTools = (opts: {
    page: Page;
    context?: BrowserContext;
    sinks?: TraceSink[];
    hooks?: TraceHooks;
}): { tools: BrowserAutomationTools; ctx: TraceContext } => {
    const ctx = createTraceContext({ sinks: opts.sinks, hooks: opts.hooks });
    let currentPage = opts.page;

    const run = <T,>(op: TraceOpName, args: unknown, fn: () => Promise<T>) =>
        traceCall(ctx, { op, args }, fn);

    const tools: BrowserAutomationTools = {
        'trace.context.newPage': async () =>
            run('trace.context.newPage', undefined, async () => {
                if (!opts.context) {
                    throw new Error('missing browser context');
                }
                const page = await opts.context.newPage();
                currentPage = page;
            }),
        'trace.page.close': async () =>
            run('trace.page.close', undefined, async () => {
                await currentPage.close();
            }),
        'trace.page.goto': async (args) =>
            run('trace.page.goto', args, async () => {
                await currentPage.goto(args.url, { timeout: args.timeout });
            }),
        'trace.page.getInfo': async () =>
            run('trace.page.getInfo', undefined, async () => ({
                url: currentPage.url(),
                title: await currentPage.title(),
            })),
        'trace.page.snapshotA11y': async () =>
            run('trace.page.snapshotA11y', undefined, async () => {
                const snapshot = await (currentPage as any).accessibility.snapshot({
                    interestingOnly: false,
                });
                if (!snapshot) {
                    throw new Error('snapshot empty');
                }
                const raw = JSON.stringify(snapshot);
                const tree = cacheA11ySnapshot(ctx.cache, raw);
                return tree ? JSON.stringify(tree) : raw;
            }),
        'trace.page.screenshot': async (args) =>
            run('trace.page.screenshot', args, async () => {
                const buffer = await currentPage.screenshot({ fullPage: args.fullPage });
                return buffer.toString('base64');
            }),
        // locator/mouse/keyboard ops 在后续 commit 实现
        'trace.locator.waitForVisible': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.locator.scrollIntoView': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.locator.click': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.locator.focus': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.locator.fill': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.mouse.click': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.page.scrollTo': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
        'trace.keyboard.press': async () => ({
            ok: false,
            error: { code: 'ERR_UNKNOWN', message: 'not implemented', phase: 'trace' },
        }),
    };

    return { tools, ctx };
};
