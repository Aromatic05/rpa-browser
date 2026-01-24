import type { ActionHandler } from '../execute';
import type { ElementScrollIntoViewCommand, PageScrollByCommand, PageScrollToCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

export const elementScrollHandlers: Record<string, ActionHandler> = {
  'page.scrollBy': async (ctx, command) => {
    const args = (command as PageScrollByCommand).args;
    const result = await ctx.page.evaluate(
      ({ dx, dy }) => {
        window.scrollBy(dx, dy);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      },
      { dx: args.dx, dy: args.dy }
    );
    return { ok: true, tabToken: ctx.tabToken, data: result };
  },
  'page.scrollTo': async (ctx, command) => {
    const args = (command as PageScrollToCommand).args;
    const result = await ctx.page.evaluate(
      ({ x, y }) => {
        window.scrollTo(x, y);
        return { scrollX: window.scrollX, scrollY: window.scrollY };
      },
      { x: args.x, y: args.y }
    );
    return { ok: true, tabToken: ctx.tabToken, data: result };
  },
  'element.scrollIntoView': async (ctx, command) => {
    const args = (command as ElementScrollIntoViewCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const count = await locator.count();
    if (count === 0) {
      throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, 'scroll target not found');
    }
    await locator.first().waitFor({ state: 'visible', timeout: 5000 });
    await locator.first().scrollIntoViewIfNeeded();
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  }
};
