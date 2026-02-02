/**
 * Trace tools：绑定 Page/Context，提供原子操作函数集合。
 *
 * 设计说明：
 * - 统一通过 traceCall 记录 op.start/op.end
 * - 本层不做高阶策略，仅调用 Playwright 原语
 * - A11y snapshot 结果会进入 cache，供 adoptA11yNode 使用
 */

import type { BrowserContext, Page } from 'playwright';
import crypto from 'crypto';
import type {
    ToolResult,
    TraceContext,
    TraceHooks,
    TraceSink,
    TraceOpName,
    TraceTags,
} from './types';
import { traceCall } from './trace_call';
import { adoptA11yNode, cacheA11ySnapshot, type A11ySnapshotNode } from './a11y_adopt';
import { findA11yCandidates, type A11yCandidate } from './a11y_find';
import { createLoggingHooks } from './hooks';
import { invalidateA11yCache } from './a11y_cache';
import type { A11yHint } from '../steps/types';
import type { PageRegistry, WorkspaceId } from '../../runtime/page_registry';

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
    'trace.locator.waitForVisible': (args: { a11yNodeId: string; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.locator.scrollIntoView': (args: { a11yNodeId: string }) => Promise<ToolResult<void>>;
    'trace.locator.click': (args: { a11yNodeId: string; timeout?: number; button?: 'left' | 'right' | 'middle' }) => Promise<ToolResult<void>>;
    'trace.locator.focus': (args: { a11yNodeId: string }) => Promise<ToolResult<void>>;
    'trace.locator.fill': (args: { a11yNodeId: string; value: string }) => Promise<ToolResult<void>>;
    'trace.locator.type': (args: { a11yNodeId: string; text: string; delayMs?: number }) => Promise<ToolResult<void>>;
    'trace.locator.selectOption': (args: { a11yNodeId: string; values: string[]; timeout?: number }) => Promise<ToolResult<void>>;
    'trace.locator.hover': (args: { a11yNodeId: string }) => Promise<ToolResult<void>>;
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

    const tools: BrowserAutomationTools = {
        'trace.tabs.create': async (args) =>
            run('trace.tabs.create', args, async () => {
                if (!opts.pageRegistry || !opts.workspaceId) {
                    throw new Error('missing page registry');
                }
                const tabId = await opts.pageRegistry.createTab(opts.workspaceId);
                const page = await opts.pageRegistry.resolvePage({ workspaceId: opts.workspaceId, tabId });
                currentPage = page;
                if (args.url) {
                    await currentPage.goto(args.url, { timeout: args.timeout });
                }
                return { tabId };
            }),
        'trace.tabs.switch': async (args) =>
            run('trace.tabs.switch', args, async () => {
                if (!opts.pageRegistry) {
                    throw new Error('missing page registry');
                }
                opts.pageRegistry.setActiveTab(args.workspaceId, args.tabId);
                const page = await opts.pageRegistry.resolvePage({ workspaceId: args.workspaceId, tabId: args.tabId });
                currentPage = page;
            }),
        'trace.tabs.close': async (args) =>
            run('trace.tabs.close', args, async () => {
                if (!opts.pageRegistry || !opts.workspaceId) {
                    throw new Error('missing page registry');
                }
                const scope = opts.pageRegistry.resolveScope({ workspaceId: opts.workspaceId, tabId: args.tabId });
                await opts.pageRegistry.closeTab(scope.workspaceId, scope.tabId);
                const page = await opts.pageRegistry.resolvePage({ workspaceId: scope.workspaceId });
                currentPage = page;
            }),
        'trace.page.goto': async (args) => {
            const result = await run('trace.page.goto', args, async () => {
                await currentPage.goto(args.url, { timeout: args.timeout });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'navigate', ctx.tags);
            return result;
        },
        'trace.page.goBack': async (args) => {
            const result = await run('trace.page.goBack', args, async () => {
                await currentPage.goBack({ timeout: args.timeout });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'navigate', ctx.tags);
            return result;
        },
        'trace.page.reload': async (args) => {
            const result = await run('trace.page.reload', args, async () => {
                await currentPage.reload({ timeout: args.timeout });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'navigate', ctx.tags);
            return result;
        },
        'trace.page.getInfo': async () =>
            run('trace.page.getInfo', undefined, async () => {
                const info = { url: currentPage.url(), title: await currentPage.title() };
                if (!opts.pageRegistry || !opts.workspaceId) return info;
                const tabs = await opts.pageRegistry.listTabs(opts.workspaceId);
                const active = opts.pageRegistry.resolveScope({ workspaceId: opts.workspaceId });
                return {
                    ...info,
                    tabId: active.tabId,
                    tabs: tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
                };
            }),
        'trace.page.snapshotA11y': async (args) =>
            run('trace.page.snapshotA11y', args, async () => {
                const snapshotId = crypto.randomUUID();
                ctx.cache.lastSnapshotId = snapshotId;
                if (!args.includeA11y) {
                    return { snapshotId };
                }
                const tree = await getA11yTree(currentPage, ctx.cache);
                return { snapshotId, a11y: tree ? JSON.stringify(tree) : undefined };
            }),
        'trace.page.screenshot': async (args) =>
            run('trace.page.screenshot', args, async () => {
                if (args.a11yNodeId) {
                    await ensureA11yCache();
                    const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                    if (!adopted.ok) throw adopted.error;
                    const buffer = await adopted.data!.screenshot();
                    return buffer.toString('base64');
                }
                const buffer = await currentPage.screenshot({ fullPage: args.fullPage });
                return buffer.toString('base64');
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
        'trace.page.scrollBy': async (args) =>
            run('trace.page.scrollBy', args, async () => {
                const deltaY = args.direction === 'up' ? -Math.abs(args.amount) : Math.abs(args.amount);
                await currentPage.evaluate(
                    ({ deltaY }) => {
                        window.scrollBy(0, deltaY);
                    },
                    { deltaY },
                );
            }),
        'trace.a11y.findByA11yHint': async (args) =>
            run('trace.a11y.findByA11yHint', args, async () => {
                const tree = await getA11yTree(currentPage, ctx.cache);
                if (!tree) return [];
                return findA11yCandidates(tree, args.hint);
            }),
        'trace.a11y.resolveByNodeId': async (args) =>
            run('trace.a11y.resolveByNodeId', args, async () => {
                await ensureA11yCache();
                const tree = ctx.cache.a11yTree as A11ySnapshotNode | undefined;
                if (!tree || !ctx.cache.a11yNodeMap?.has(args.a11yNodeId)) {
                    throw { code: 'ERR_NOT_FOUND', message: 'a11y node not found', phase: 'trace' };
                }
                return { a11yNodeId: args.a11yNodeId };
            }),
        'trace.locator.waitForVisible': async (args) =>
            run('trace.locator.waitForVisible', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.waitFor({ state: 'visible', timeout: args.timeout });
            }),
        'trace.locator.scrollIntoView': async (args) => {
            const result = await run('trace.locator.scrollIntoView', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.scrollIntoViewIfNeeded();
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'scroll', ctx.tags);
            return result;
        },
        'trace.locator.click': async (args) => {
            const result = await run('trace.locator.click', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.click({ timeout: args.timeout, button: args.button });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'click', ctx.tags);
            return result;
        },
        'trace.locator.focus': async (args) =>
            run('trace.locator.focus', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.focus();
            }),
        'trace.locator.fill': async (args) => {
            const result = await run('trace.locator.fill', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.fill(args.value);
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'input', ctx.tags);
            return result;
        },
        'trace.locator.type': async (args) => {
            const result = await run('trace.locator.type', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.type(args.text, { delay: args.delayMs });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'input', ctx.tags);
            return result;
        },
        'trace.locator.selectOption': async (args) => {
            const result = await run('trace.locator.selectOption', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.selectOption(args.values, { timeout: args.timeout });
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'input', ctx.tags);
            return result;
        },
        'trace.locator.hover': async (args) =>
            run('trace.locator.hover', args, async () => {
                await ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, ctx.cache);
                if (!adopted.ok) throw adopted.error;
                await adopted.data!.hover();
            }),
        'trace.locator.dragDrop': async (args) =>
            run('trace.locator.dragDrop', args, async () => {
                await ensureA11yCache();
                const source = await adoptA11yNode(currentPage, args.sourceNodeId, ctx.cache);
                if (!source.ok) throw source.error;
                if (args.destNodeId) {
                    const dest = await adoptA11yNode(currentPage, args.destNodeId, ctx.cache);
                    if (!dest.ok) throw dest.error;
                    await source.data!.dragTo(dest.data!);
                    return;
                }
                if (!args.destCoord) {
                    throw { code: 'ERR_NOT_FOUND', message: 'missing drag destination', phase: 'trace' };
                }
                const box = await source.data!.boundingBox();
                if (!box) {
                    throw { code: 'ERR_NOT_FOUND', message: 'source not visible', phase: 'trace' };
                }
                const startX = box.x + box.width / 2;
                const startY = box.y + box.height / 2;
                await currentPage.mouse.move(startX, startY);
                await currentPage.mouse.down();
                await currentPage.mouse.move(args.destCoord.x, args.destCoord.y);
                await currentPage.mouse.up();
            }),
        'trace.keyboard.press': async (args) => {
            const result = await run('trace.keyboard.press', args, async () => {
                await currentPage.keyboard.press(args.key);
            });
            if (result.ok) invalidateA11yCache(ctx.cache, 'keyboard', ctx.tags);
            return result;
        },
        'trace.mouse.action': async (args) => {
            const result = await run('trace.mouse.action', args, async () => {
                await currentPage.mouse.move(args.x, args.y);
                if (args.action === 'move') return;
                if (args.action === 'down') {
                    await currentPage.mouse.down({ button: args.button });
                    return;
                }
                if (args.action === 'up') {
                    await currentPage.mouse.up({ button: args.button });
                    return;
                }
                if (args.action === 'wheel') {
                    await currentPage.mouse.wheel(0, args.deltaY || 0);
                }
            });
            if (result.ok && (args.action === 'down' || args.action === 'up')) {
                invalidateA11yCache(ctx.cache, 'mouse', ctx.tags);
            }
            return result;
        },
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

const getA11yTree = async (page: Page, cache: TraceContext['cache']): Promise<A11ySnapshotNode | null> => {
    if (cache.a11yTree) return cache.a11yTree as A11ySnapshotNode;
    const snapshot = await (page as any).accessibility?.snapshot?.({
        interestingOnly: false,
    });
    if (snapshot) {
        const raw = JSON.stringify(snapshot);
        return cacheA11ySnapshot(cache, raw);
    }
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const tree = buildA11yTreeFromCdp(nodes);
    const raw = JSON.stringify(tree);
    return cacheA11ySnapshot(cache, raw);
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
