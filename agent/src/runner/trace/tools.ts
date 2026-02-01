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
    TraceTags,
} from './types';
import { traceCall } from './trace_call';
import { adoptA11yNode, cacheA11ySnapshot } from './a11y_adopt';
import { createLoggingHooks } from './hooks';

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
    sinks?: TraceSink[];
    hooks?: TraceHooks;
    tags?: TraceTags;
}): { tools: BrowserAutomationTools; ctx: TraceContext } => {
    const ctx = createTraceContext({ sinks: opts.sinks, hooks: opts.hooks, tags: opts.tags });
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
            const snapshot = await (currentPage as any).accessibility?.snapshot?.({
                interestingOnly: false,
            });
            if (snapshot) {
                const raw = JSON.stringify(snapshot);
                const tree = cacheA11ySnapshot(ctx.cache, raw);
                return tree ? JSON.stringify(tree) : raw;
            }
            const cdp = await currentPage.context().newCDPSession(currentPage);
            await cdp.send('Accessibility.enable');
            const { nodes } = await cdp.send('Accessibility.getFullAXTree');
            const tree = buildA11yTreeFromCdp(nodes);
            const raw = JSON.stringify(tree);
            const cached = cacheA11ySnapshot(ctx.cache, raw);
            return cached ? JSON.stringify(cached) : raw;
        }),
        'trace.page.screenshot': async (args) =>
            run('trace.page.screenshot', args, async () => {
                const buffer = await currentPage.screenshot({ fullPage: args.fullPage });
                return buffer.toString('base64');
            }),
        'trace.locator.waitForVisible': async (args) =>
            run('trace.locator.waitForVisible', args, async () => {
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.waitFor({ state: 'visible', timeout: args.timeout });
            }),
        'trace.locator.scrollIntoView': async (args) =>
            run('trace.locator.scrollIntoView', args, async () => {
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.scrollIntoViewIfNeeded();
            }),
        'trace.locator.click': async (args) =>
            run('trace.locator.click', args, async () => {
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.click({ timeout: args.timeout });
            }),
        'trace.locator.focus': async (args) =>
            run('trace.locator.focus', args, async () => {
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.focus();
            }),
        'trace.locator.fill': async (args) =>
            run('trace.locator.fill', args, async () => {
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.fill(args.value);
            }),
        'trace.mouse.click': async (args) =>
            run('trace.mouse.click', args, async () => {
                await currentPage.mouse.click(args.x, args.y);
            }),
        'trace.page.scrollTo': async (args) =>
            run('trace.page.scrollTo', args, async () => {
                await currentPage.evaluate(
                    ({ x, y }) => {
                        window.scrollTo(x, y);
                    },
                    { x: args.x, y: args.y },
                );
            }),
        'trace.keyboard.press': async (args) =>
            run('trace.keyboard.press', args, async () => {
                await currentPage.keyboard.press(args.key);
            }),
    };

    return { tools, ctx };
};

type CdpAXNode = {
    nodeId: string;
    ignored?: boolean;
    role?: { value?: string };
    name?: { value?: string };
    description?: { value?: string };
    value?: { value?: string };
    parentId?: string;
    childIds?: string[];
};

type RawA11yNode = {
    role?: string;
    name?: string;
    description?: string;
    value?: string;
    children?: RawA11yNode[];
};

const buildA11yTreeFromCdp = (nodes: CdpAXNode[]): RawA11yNode => {
    const map = new Map<string, CdpAXNode>();
    for (const node of nodes) {
        map.set(node.nodeId, node);
    }

    const root =
        nodes.find((node) => !node.parentId && !node.ignored) ||
        nodes.find((node) => !node.parentId) ||
        nodes[0];

    const visited = new Set<string>();
    const walk = (id: string): RawA11yNode | null => {
        if (visited.has(id)) return null;
        const node = map.get(id);
        if (!node) return null;
        visited.add(id);
        const children = (node.childIds || [])
            .map((childId) => walk(childId))
            .filter((child): child is RawA11yNode => Boolean(child));
        return {
            role: node.role?.value,
            name: node.name?.value,
            description: node.description?.value,
            value: node.value?.value,
            children: children.length ? children : undefined,
        };
    };

    return root ? walk(root.nodeId) || { role: 'document' } : { role: 'document' };
};
