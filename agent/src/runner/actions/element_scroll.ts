import type { ActionHandler } from '../execute';
import type {
    ElementScrollIntoViewCommand,
    PageScrollByCommand,
    PageScrollToCommand,
} from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

export const elementScrollHandlers: Record<string, ActionHandler> = {
    'page.scrollBy': async (ctx, command) => {
        const args = (command as PageScrollByCommand).args;
        const result = await ctx.page.evaluate(
            async ({ dx, dy, duration }) => {
                const startX = window.scrollX;
                const startY = window.scrollY;
                const targetX = startX + dx;
                const targetY = startY + dy;
                const start = performance.now();
                const ease = (t: number) => t * (2 - t);
                await new Promise<void>((resolve) => {
                    const tick = (now: number) => {
                        const elapsed = Math.min(1, (now - start) / duration);
                        const eased = ease(elapsed);
                        window.scrollTo(
                            startX + (targetX - startX) * eased,
                            startY + (targetY - startY) * eased,
                        );
                        if (elapsed < 1) {
                            requestAnimationFrame(tick);
                        } else {
                            resolve();
                        }
                    };
                    requestAnimationFrame(tick);
                });
                return { scrollX: window.scrollX, scrollY: window.scrollY };
            },
            { dx: args.dx, dy: args.dy, duration: 450 },
        );
        return { ok: true, tabToken: ctx.tabToken, data: result };
    },
    'page.scrollTo': async (ctx, command) => {
        const args = (command as PageScrollToCommand).args;
        const result = await ctx.page.evaluate(
            async ({ x, y, duration }) => {
                const startX = window.scrollX;
                const startY = window.scrollY;
                const targetX = x;
                const targetY = y;
                const start = performance.now();
                const ease = (t: number) => t * (2 - t);
                await new Promise<void>((resolve) => {
                    const tick = (now: number) => {
                        const elapsed = Math.min(1, (now - start) / duration);
                        const eased = ease(elapsed);
                        window.scrollTo(
                            startX + (targetX - startX) * eased,
                            startY + (targetY - startY) * eased,
                        );
                        if (elapsed < 1) {
                            requestAnimationFrame(tick);
                        } else {
                            resolve();
                        }
                    };
                    requestAnimationFrame(tick);
                });
                return { scrollX: window.scrollX, scrollY: window.scrollY };
            },
            { x: args.x, y: args.y, duration: 450 },
        );
        return { ok: true, tabToken: ctx.tabToken, data: result };
    },
    'element.scrollIntoView': async (ctx, command) => {
        const args = (command as ElementScrollIntoViewCommand).args;
        const { locator } = await resolveTarget({
            page: ctx.page,
            tabToken: ctx.tabToken,
            target: args.target,
            pageRegistry: ctx.pageRegistry,
        });
        const count = await locator.count();
        if (count === 0) {
            throw new ActionError(ERROR_CODES.ERR_NOT_FOUND, 'scroll target not found');
        }
        await locator.first().waitFor({ state: 'visible', timeout: 5000 });
        await locator.first().evaluate((el) => {
            el.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        });
        await ctx.page.waitForTimeout(450);
        return { ok: true, tabToken: ctx.tabToken, data: { pageUrl: ctx.page.url() } };
    },
};
