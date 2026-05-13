import type { ToolsBuildContext } from './context';

export const createTabsTools = (base: ToolsBuildContext) => ({
    'trace.tabs.create': async (args: { workspaceName: string; url?: string; timeout?: number }) =>
        await base.run('trace.tabs.create', args, async () => {
            const context = base.getCurrentPage().context();
            const page = await context.newPage();
            if (args.url) {
                await page.goto(args.url, {
                    timeout: args.timeout,
                    waitUntil: 'domcontentloaded',
                });
            } else {
                await page.goto('about:blank', {
                    timeout: args.timeout,
                    waitUntil: 'domcontentloaded',
                });
            }
            await page.bringToFront().catch(() => undefined);
            base.setCurrentPage(page);
            return { tabName: '' };
        }),

    'trace.tabs.switch': async (args: { workspaceName: string; tabName: string }) =>
        await base.run('trace.tabs.switch', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            const page = await base.opts.pageRegistry.awaitPageBinding(args.tabName, { timeoutMs: 1500 });
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
