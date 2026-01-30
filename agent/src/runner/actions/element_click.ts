import type { ActionHandler } from '../execute';
import type {
    ElementClickCommand,
    ElementDblClickCommand,
    ElementHoverCommand,
    ElementRightClickCommand,
} from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';

export const elementClickHandlers: Record<string, ActionHandler> = {
    'element.click': async (ctx, command) => {
        const args = (command as ElementClickCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const options = { timeout: 5000, ...args.options };
        await locator.click(options);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'element.dblclick': async (ctx, command) => {
        const args = (command as ElementDblClickCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const options = { timeout: 5000, ...args.options };
        await locator.dblclick(options);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'element.rightclick': async (ctx, command) => {
        const args = (command as ElementRightClickCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const options = { timeout: 5000, button: 'right' as const, ...(args.options || {}) };
        await locator.click(options);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'element.hover': async (ctx, command) => {
        const args = (command as ElementHoverCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const options = { timeout: 5000, ...args.options };
        await locator.hover(options);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
};
