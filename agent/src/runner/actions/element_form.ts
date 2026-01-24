import type { ActionHandler } from '../execute';
import type { ElementClearCommand, ElementFillCommand, ElementTypeCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';

export const elementFormHandlers: Record<string, ActionHandler> = {
    'element.fill': async (ctx, command) => {
        const args = (command as ElementFillCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.fill(args.text, args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'element.type': async (ctx, command) => {
        const args = (command as ElementTypeCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.type(args.text, args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'element.clear': async (ctx, command) => {
        const args = (command as ElementClearCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        await locator.fill('', args.options || {});
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
};
