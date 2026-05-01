import type { WorkspaceName } from '../../../runtime/page_registry';
import type { ToolsBuildContext } from './context';

export const createTabsTools = (base: ToolsBuildContext) => ({
    'trace.tabs.create': async (args: { workspaceName: WorkspaceName; url?: string; timeout?: number }) =>
        await base.run('trace.tabs.create', args, async () => {
            if (!base.opts.pageRegistry || !base.opts.workspaceName) {
                throw new Error('missing page registry');
            }
            const tabId = await base.opts.pageRegistry.createTab(base.opts.workspaceName);
            const page = await base.opts.pageRegistry.resolvePage({ workspaceName: base.opts.workspaceName, tabId });
            base.setCurrentPage(page);
            if (args.url) {
                await page.goto(args.url, { timeout: args.timeout });
            }
            // Keep headed replay deterministic: operate on the visible tab.
            await page.bringToFront().catch(() => undefined);
            return { tabId };
        }),

    'trace.tabs.switch': async (args: { workspaceName: WorkspaceName; tabId: string }) =>
        await base.run('trace.tabs.switch', args, async () => {
            if (!base.opts.pageRegistry) {
                throw new Error('missing page registry');
            }
            base.opts.pageRegistry.setActiveTab(args.workspaceName, args.tabId);
            const page = await base.opts.pageRegistry.resolvePage({ workspaceName: args.workspaceName, tabId: args.tabId });
            base.setCurrentPage(page);
            // A tab switch step is only complete when target tab is actually foregrounded.
            await page.bringToFront();
            await page.waitForTimeout(120);
            await page.waitForFunction(
                () => document.visibilityState === 'visible' && document.hasFocus(),
                undefined,
                { timeout: 2500 },
            );
        }),

    'trace.tabs.close': async (args: { workspaceName: WorkspaceName; tabId?: string }) =>
        await base.run('trace.tabs.close', args, async () => {
            if (!base.opts.pageRegistry || !base.opts.workspaceName) {
                throw new Error('missing page registry');
            }
            const scope = base.opts.pageRegistry.resolveScope({ workspaceName: base.opts.workspaceName, tabId: args.tabId });
            await base.opts.pageRegistry.closeTab(scope.workspaceName, scope.tabId);
            const page = await base.opts.pageRegistry.resolvePage({ workspaceName: scope.workspaceName });
            base.setCurrentPage(page);
        }),
});
