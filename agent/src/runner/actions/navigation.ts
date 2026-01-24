import type { ActionHandler } from '../execute';
import type {
    EnsureSessionCommand,
    PageBackCommand,
    PageForwardCommand,
    PageGotoCommand,
    PageReloadCommand,
    WaitForLoadStateCommand,
    WaitForURLCommand,
} from '../commands';

const normalizeUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        return `${parsed.origin}${parsed.pathname}`;
    } catch {
        return url;
    }
};

export const navigationHandlers: Record<string, ActionHandler> = {
    ensureSession: async (ctx, command) => {
        const args = (command as EnsureSessionCommand).args;
        if (args?.url) {
            await ctx.page.goto(args.url, { waitUntil: 'domcontentloaded' });
        }
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
    'page.goto': async (ctx, command) => {
        const args = (command as PageGotoCommand).args;
        const current = normalizeUrl(ctx.page.url());
        const target = normalizeUrl(args.url);
        if (current && target && current === target) {
            return {
                ok: true,
                tabToken: ctx.tabToken,
                data: { pageUrl: ctx.page.url(), skipped: true },
            };
        }
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
    },
};
