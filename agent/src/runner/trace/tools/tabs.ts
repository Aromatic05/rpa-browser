import crypto from 'crypto';
import type { ToolsBuildContext } from './context';

export const createTabsTools = (base: ToolsBuildContext) => ({
    'trace.tabs.create': async (args: { workspaceName: string; url?: string; timeout?: number }) =>
        await base.run('trace.tabs.create', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const tabName = crypto.randomUUID();
            const page = await base.opts.pageRegistry.getPage(tabName, args.url);
            base.setCurrentPage(page);
            await page.bringToFront().catch(() => undefined);
            return { tabName };
        }),

    'trace.tabs.switch': async (args: { workspaceName: string; tabName: string }) =>
        await base.run('trace.tabs.switch', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const page = await base.opts.pageRegistry.getPage(args.tabName);
            base.setCurrentPage(page);
            await page.bringToFront().catch(() => undefined);
        }),

    'trace.tabs.close': async (args: { workspaceName: string; tabName?: string }) =>
        await base.run('trace.tabs.close', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const tabName = args.tabName;
            if (!tabName) {
                throw new Error('tabName is required');
            }
            await base.opts.pageRegistry.closePage(tabName);
        }),
});
