import crypto from 'crypto';
import type { Page } from 'playwright';
import { adoptA11yNode } from '../a11y/adopt';
import { invalidateA11yCache } from '../a11y/cache';
import { getA11yTree } from '../a11y/getA11yTree';
import type { ConsoleEntry, NetworkEntry } from '../types';
import type { ToolsBuildContext } from './context';

export const createPageTools = (base: ToolsBuildContext) => ({
    'trace.page.goto': async (args: { url: string; timeout?: number }) => {
        const result = await base.run('trace.page.goto', args, async () => {
            await base.getCurrentPage().goto(args.url, { timeout: args.timeout });
        });
        if (result.ok) {invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);}
        return result;
    },

    'trace.page.goBack': async (args: { timeout?: number }) => {
        const result = await base.run('trace.page.goBack', args, async () => {
            await base.getCurrentPage().goBack({ timeout: args.timeout });
        });
        if (result.ok) {invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);}
        return result;
    },

    'trace.page.reload': async (args: { timeout?: number }) => {
        const result = await base.run('trace.page.reload', args, async () => {
            await base.getCurrentPage().reload({ timeout: args.timeout });
        });
        if (result.ok) {invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);}
        return result;
    },

    'trace.page.getInfo': async () =>
        await base.run('trace.page.getInfo', undefined, async () => {
            const currentPage = base.getCurrentPage();
            const info = { url: currentPage.url(), title: await currentPage.title() };
            if (!base.opts.pageRegistry || !base.opts.workspaceId) {return info;}
            const tabs = await base.opts.pageRegistry.listTabs(base.opts.workspaceId);
            const active = base.opts.pageRegistry.resolveScope({ workspaceId: base.opts.workspaceId });
            return {
                ...info,
                tabId: active.tabId,
                tabs: tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
            };
        }),

    'trace.page.snapshotA11y': async (args: { includeA11y: boolean; focusOnly: boolean }) =>
        await base.run('trace.page.snapshotA11y', args, async () => {
            const snapshotId = crypto.randomUUID();
            base.ctx.cache.lastSnapshotId = snapshotId;
            if (!args.includeA11y) {
                return { snapshotId };
            }
            const tree = await getA11yTree(base.getCurrentPage(), base.ctx.cache);
            return { snapshotId, a11y: tree ? JSON.stringify(tree) : undefined };
        }),

    'trace.page.getContent': async (args: { ref: string }) =>
        await base.run('trace.page.getContent', args, async () => {
            const snapshot = base.ctx.cache.latestSnapshot as
                | { contentStore?: Record<string, string> }
                | undefined;
            const content = snapshot?.contentStore?.[args.ref];
            if (typeof content !== 'string') {
                throw {
                    code: 'ERR_NOT_FOUND',
                    message: 'content ref not found in latest snapshot',
                    phase: 'trace',
                    details: { ref: args.ref },
                };
            }
            return { ref: args.ref, content };
        }),

    'trace.page.readConsole': async (args?: { limit?: number }) =>
        await base.run('trace.page.readConsole', args, async () => {
            const records = ensurePageDiagnostics(base.getCurrentPage(), base.ctx.cache).consoleEntries;
            return takeLast(records, args?.limit);
        }),

    'trace.page.readNetwork': async (args?: { limit?: number }) =>
        await base.run('trace.page.readNetwork', args, async () => {
            const records = ensurePageDiagnostics(base.getCurrentPage(), base.ctx.cache).networkEntries;
            return takeLast(records, args?.limit);
        }),

    'trace.page.evaluate': async (args: { expression: string; arg?: unknown }) =>
        await base.run('trace.page.evaluate', args, async () => {
            return await base.getCurrentPage().evaluate(
                ({ expression, arg }) => {
                    try {
                        const fn = new Function('arg', `return (${expression});`);
                        return fn(arg);
                    } catch {
                        const fn = new Function('arg', expression);
                        return fn(arg);
                    }
                },
                { expression: args.expression, arg: args.arg },
            );
        }),

    'trace.page.screenshot': async (args: { fullPage?: boolean; a11yNodeId?: string; selector?: string; role?: string; name?: string }) =>
        await base.run('trace.page.screenshot', args, async () => {
            const currentPage = base.getCurrentPage();
            ensurePageDiagnostics(currentPage, base.ctx.cache);
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                const buffer = await locator.screenshot();
                return buffer.toString('base64');
            }
            if (args.role) {
                const locator = currentPage.getByRole(args.role as any, args.name ? { name: args.name } : undefined);
                const count = await locator.count();
                if (count === 0) {
                    throw { code: 'ERR_NOT_FOUND', message: 'role locator not found', phase: 'trace', details: { role: args.role, name: args.name } };
                }
                if (count > 1) {
                    throw {
                        code: 'ERR_AMBIGUOUS',
                        message: 'role locator matches multiple elements',
                        phase: 'trace',
                        details: { role: args.role, name: args.name, count },
                    };
                }
                const buffer = await locator.first().screenshot();
                return buffer.toString('base64');
            }
            if (args.a11yNodeId) {
                await base.ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, base.ctx.cache);
                if (!adopted.ok) {throw adopted.error;}
                const buffer = await adopted.data!.screenshot();
                return buffer.toString('base64');
            }
            const buffer = await currentPage.screenshot({ fullPage: args.fullPage });
            return buffer.toString('base64');
        }),

    'trace.page.scrollTo': async (args: { x: number; y: number }) =>
        await base.run('trace.page.scrollTo', args, async () => {
            await base.getCurrentPage().evaluate(
                ({ x, y }) => {
                    window.scrollTo(x, y);
                },
                { x: args.x, y: args.y },
            );
        }),

    'trace.page.scrollBy': async (args: { direction: 'up' | 'down'; amount: number }) =>
        await base.run('trace.page.scrollBy', args, async () => {
            const deltaY = args.direction === 'up' ? -Math.abs(args.amount) : Math.abs(args.amount);
            await base.getCurrentPage().evaluate(
                ({ deltaY }) => {
                    window.scrollBy(0, deltaY);
                },
                { deltaY },
            );
        }),
});

type PageDiagnosticsState = {
    consoleEntries: ConsoleEntry[];
    networkEntries: NetworkEntry[];
};

const diagnosticsByPage = new WeakMap<Page, PageDiagnosticsState>();

const ensurePageDiagnostics = (page: Page, cache: { consoleEntries?: ConsoleEntry[]; networkEntries?: NetworkEntry[] }) => {
    const existing = diagnosticsByPage.get(page);
    if (existing) {
        cache.consoleEntries = existing.consoleEntries;
        cache.networkEntries = existing.networkEntries;
        return existing;
    }

    const state: PageDiagnosticsState = {
        consoleEntries: [],
        networkEntries: [],
    };

    page.on('console', (message) => {
        pushBounded(state.consoleEntries, {
            ts: Date.now(),
            type: message.type(),
            text: message.text(),
            location: message.location(),
        });
    });

    page.on('response', (response) => {
        const request = response.request();
        pushBounded(state.networkEntries, {
            ts: Date.now(),
            type: 'response',
            url: response.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            status: response.status(),
            ok: response.ok(),
        });
    });

    page.on('requestfailed', (request) => {
        pushBounded(state.networkEntries, {
            ts: Date.now(),
            type: 'failed',
            url: request.url(),
            method: request.method(),
            resourceType: request.resourceType(),
            failureText: request.failure()?.errorText,
        });
    });

    diagnosticsByPage.set(page, state);
    cache.consoleEntries = state.consoleEntries;
    cache.networkEntries = state.networkEntries;
    return state;
};

const takeLast = <T>(items: T[], limit = 50): T[] => {
    const safeLimit = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 50));
    return items.slice(-safeLimit);
};

const pushBounded = <T>(bucket: T[], value: T) => {
    bucket.push(value);
    if (bucket.length > 1000) {
        bucket.splice(0, bucket.length - 1000);
    }
};
