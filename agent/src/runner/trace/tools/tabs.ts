import crypto from 'crypto';
import type { ToolsBuildContext } from './context';

export const createTabsTools = (base: ToolsBuildContext) => ({
    'trace.tabs.create': async (args: { workspaceName: string; url?: string; timeout?: number }) =>
        await base.run('trace.tabs.create', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const tabId = crypto.randomUUID();
            const page = await base.opts.pageRegistry.getPage(tabId, args.url);
            base.setCurrentPage(page);
            await page.bringToFront().catch(() => undefined);
            return { tabId };
        }),

    'trace.tabs.switch': async (args: { workspaceName: string; tabId: string }) =>
        await base.run('trace.tabs.switch', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const page = await base.opts.pageRegistry.getPage(args.tabId);
            base.setCurrentPage(page);
            await page.bringToFront().catch(() => undefined);
        }),

    'trace.tabs.close': async (args: { workspaceName: string; tabId?: string }) =>
        await base.run('trace.tabs.close', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const tabId = args.tabId;
            if (!tabId) {
                throw new Error('tabId is required');
            }
            await base.opts.pageRegistry.closePage(tabId);
        }),
});
