import crypto from 'node:crypto';
import { ACTION_TYPES } from '../../../actions/action_types';
import type { ToolsBuildContext } from './context';

export const createTabsTools = (base: ToolsBuildContext) => ({
    'trace.tabs.create': async (args: { workspaceName: string; url?: string; timeout?: number }) =>
        await base.run('trace.tabs.create', args, async () => {
            if (!base.opts.dispatchAction) {
                throw new Error('missing action dispatcher');
            }
            const workspaceName = args.workspaceName || base.opts.workspaceName;
            if (!workspaceName) {
                throw new Error('workspaceName is required');
            }
            const createId = crypto.randomUUID();
            const opened = await base.opts.dispatchAction({
                v: 1,
                id: crypto.randomUUID(),
                type: ACTION_TYPES.TAB_OPEN,
                workspaceName,
                payload: {
                    source: 'trace.tabs.create',
                    createId,
                },
                at: Date.now(),
            });
            if (opened.type.endsWith('.failed')) {
                throw new Error(String((opened.payload as { message?: unknown })?.message || 'tab.open failed'));
            }
            return { tabName: createId };
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
