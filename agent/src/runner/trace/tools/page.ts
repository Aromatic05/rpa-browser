import crypto from 'crypto';
import { adoptA11yNode } from '../a11y/adopt';
import { invalidateA11yCache } from '../a11y/cache';
import { getA11yTree } from '../a11y/getA11yTree';
import type { ToolsBuildContext } from './context';

export const createPageTools = (base: ToolsBuildContext) => ({
    'trace.page.goto': async (args: { url: string; timeout?: number }) => {
        const result = await base.run('trace.page.goto', args, async () => {
            await base.getCurrentPage().goto(args.url, { timeout: args.timeout });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);
        return result;
    },

    'trace.page.goBack': async (args: { timeout?: number }) => {
        const result = await base.run('trace.page.goBack', args, async () => {
            await base.getCurrentPage().goBack({ timeout: args.timeout });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);
        return result;
    },

    'trace.page.reload': async (args: { timeout?: number }) => {
        const result = await base.run('trace.page.reload', args, async () => {
            await base.getCurrentPage().reload({ timeout: args.timeout });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'navigate', base.ctx.tags);
        return result;
    },

    'trace.page.getInfo': async () =>
        base.run('trace.page.getInfo', undefined, async () => {
            const currentPage = base.getCurrentPage();
            const info = { url: currentPage.url(), title: await currentPage.title() };
            if (!base.opts.pageRegistry || !base.opts.workspaceId) return info;
            const tabs = await base.opts.pageRegistry.listTabs(base.opts.workspaceId);
            const active = base.opts.pageRegistry.resolveScope({ workspaceId: base.opts.workspaceId });
            return {
                ...info,
                tabId: active.tabId,
                tabs: tabs.map((tab) => ({ tabId: tab.tabId, url: tab.url, title: tab.title })),
            };
        }),

    'trace.page.snapshotA11y': async (args: { includeA11y: boolean; focusOnly: boolean }) =>
        base.run('trace.page.snapshotA11y', args, async () => {
            const snapshotId = crypto.randomUUID();
            base.ctx.cache.lastSnapshotId = snapshotId;
            if (!args.includeA11y) {
                return { snapshotId };
            }
            const tree = await getA11yTree(base.getCurrentPage(), base.ctx.cache);
            return { snapshotId, a11y: tree ? JSON.stringify(tree) : undefined };
        }),

    'trace.page.screenshot': async (args: { fullPage?: boolean; a11yNodeId?: string }) =>
        base.run('trace.page.screenshot', args, async () => {
            const currentPage = base.getCurrentPage();
            if (args.a11yNodeId) {
                await base.ensureA11yCache();
                const adopted = await adoptA11yNode(currentPage, args.a11yNodeId, base.ctx.cache);
                if (!adopted.ok) throw adopted.error;
                const buffer = await adopted.data!.screenshot();
                return buffer.toString('base64');
            }
            const buffer = await currentPage.screenshot({ fullPage: args.fullPage });
            return buffer.toString('base64');
        }),

    'trace.page.scrollTo': async (args: { x: number; y: number }) =>
        base.run('trace.page.scrollTo', args, async () => {
            await base.getCurrentPage().evaluate(
                ({ x, y }) => {
                    window.scrollTo(x, y);
                },
                { x: args.x, y: args.y },
            );
        }),

    'trace.page.scrollBy': async (args: { direction: 'up' | 'down'; amount: number }) =>
        base.run('trace.page.scrollBy', args, async () => {
            const deltaY = args.direction === 'up' ? -Math.abs(args.amount) : Math.abs(args.amount);
            await base.getCurrentPage().evaluate(
                ({ deltaY }) => {
                    window.scrollBy(0, deltaY);
                },
                { deltaY },
            );
        }),
});
