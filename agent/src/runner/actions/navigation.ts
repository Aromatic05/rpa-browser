import type { ActionHandler } from '../execute';
import type {
  PageBackCommand,
  PageForwardCommand,
  PageGotoCommand,
  PageReloadCommand,
  WaitForLoadStateCommand,
  WaitForURLCommand
} from '../commands';

export const navigationHandlers: Record<string, ActionHandler> = {
  'page.goto': async (ctx, command) => {
    const args = (command as PageGotoCommand).args;
    await ctx.page.goto(args.url, { waitUntil: args.waitUntil || 'domcontentloaded' });
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  },
  'page.back': async (ctx, _command) => {
    await ctx.page.goBack({ waitUntil: 'domcontentloaded' });
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  },
  'page.forward': async (ctx, _command) => {
    await ctx.page.goForward({ waitUntil: 'domcontentloaded' });
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  },
  'page.reload': async (ctx, command) => {
    const args = (command as PageReloadCommand).args;
    await ctx.page.reload({ waitUntil: args.waitUntil || 'domcontentloaded' });
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  },
  'wait.forLoadState': async (ctx, command) => {
    const args = (command as WaitForLoadStateCommand).args;
    await ctx.page.waitForLoadState(args.state, { timeout: args.timeout });
    return { ok: true, tabToken: ctx.tabToken, data: { state: args.state } };
  },
  'wait.forURL': async (ctx, command) => {
    const args = (command as WaitForURLCommand).args;
    await ctx.page.waitForURL(args.urlOrPattern, { timeout: args.timeout });
    return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
  }
};
