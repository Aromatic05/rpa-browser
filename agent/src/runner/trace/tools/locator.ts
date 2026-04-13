import { adoptA11yNode, type A11ySnapshotNode } from '../a11y/adopt';
import { invalidateA11yCache } from '../a11y/cache';
import { findA11yCandidates, type A11yCandidate } from '../a11y/find';
import { getA11yTree } from '../a11y/getA11yTree';
import type { Locator } from 'playwright';
import type { A11yHint } from '../../steps/types';
import type { ToolsBuildContext } from './context';

type LocatorTarget = {
    a11yNodeId?: string;
    selector?: string;
    role?: string;
    name?: string;
};

export const createLocatorTools = (base: ToolsBuildContext) => ({
    'trace.a11y.findByA11yHint': async (args: { hint: A11yHint }) =>
        base.run('trace.a11y.findByA11yHint', args, async (): Promise<A11yCandidate[]> => {
            const tree = await getA11yTree(base.getCurrentPage(), base.ctx.cache);
            if (!tree) return [];
            return findA11yCandidates(tree, args.hint);
        }),

    'trace.a11y.resolveByNodeId': async (args: { a11yNodeId: string }) =>
        base.run('trace.a11y.resolveByNodeId', args, async () => {
            await base.ensureA11yCache();
            const tree = base.ctx.cache.a11yTree as A11ySnapshotNode | undefined;
            if (!tree || !base.ctx.cache.a11yNodeMap?.has(args.a11yNodeId)) {
                throw { code: 'ERR_NOT_FOUND', message: 'a11y node not found', phase: 'trace' };
            }
            return { a11yNodeId: args.a11yNodeId };
        }),

    'trace.locator.waitForVisible': async (args: LocatorTarget & { timeout?: number }) =>
        base.run('trace.locator.waitForVisible', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.waitFor({ state: 'visible', timeout: args.timeout });
        }),

    'trace.locator.scrollIntoView': async (args: LocatorTarget) => {
        const result = await base.run('trace.locator.scrollIntoView', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.scrollIntoViewIfNeeded();
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'scroll', base.ctx.tags);
        return result;
    },

    'trace.locator.click': async (args: LocatorTarget & { timeout?: number; button?: 'left' | 'right' | 'middle' }) => {
        const result = await base.run('trace.locator.click', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.click({ timeout: args.timeout, button: args.button });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'click', base.ctx.tags);
        return result;
    },

    'trace.locator.focus': async (args: LocatorTarget) =>
        base.run('trace.locator.focus', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.focus();
        }),

    'trace.locator.fill': async (args: LocatorTarget & { value: string }) => {
        const result = await base.run('trace.locator.fill', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.fill(args.value);
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.type': async (args: LocatorTarget & { text: string; delayMs?: number }) => {
        const result = await base.run('trace.locator.type', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.type(args.text, { delay: args.delayMs });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.selectOption': async (args: LocatorTarget & { values: string[]; timeout?: number }) => {
        const result = await base.run('trace.locator.selectOption', args, async () => {
            const locator = await resolveLocator(base, args);
            const selected = await locator.selectOption(args.values, { timeout: args.timeout });
            return { selected };
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.hover': async (args: LocatorTarget) =>
        base.run('trace.locator.hover', args, async () => {
            const locator = await resolveLocator(base, args);
            await locator.hover();
        }),

    'trace.locator.dragDrop': async (args: { source: LocatorTarget; dest?: LocatorTarget; destCoord?: { x: number; y: number } }) =>
        base.run('trace.locator.dragDrop', args, async () => {
            const currentPage = base.getCurrentPage();
            const source = await resolveLocator(base, args.source);
            if (args.dest) {
                const dest = await resolveLocator(base, args.dest);
                await source.dragTo(dest);
                return;
            }
            if (!args.destCoord) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing drag destination', phase: 'trace' };
            }
            const box = await source.boundingBox();
            if (!box) {
                throw { code: 'ERR_NOT_FOUND', message: 'source not visible', phase: 'trace' };
            }
            const startX = box.x + box.width / 2;
            const startY = box.y + box.height / 2;
            await currentPage.mouse.move(startX, startY);
            await currentPage.mouse.down();
            await currentPage.mouse.move(args.destCoord.x, args.destCoord.y);
            await currentPage.mouse.up();
        }),

    'trace.keyboard.press': async (args: { key: string }) => {
        const result = await base.run('trace.keyboard.press', args, async () => {
            await base.getCurrentPage().keyboard.press(args.key);
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'keyboard', base.ctx.tags);
        return result;
    },

    'trace.mouse.action': async (args: {
        action: 'move' | 'down' | 'up' | 'wheel' | 'click' | 'dblclick';
        x: number;
        y: number;
        deltaY?: number;
        button?: 'left' | 'right' | 'middle';
    }) => {
        const result = await base.run('trace.mouse.action', args, async () => {
            const currentPage = base.getCurrentPage();
            await currentPage.mouse.move(args.x, args.y);
            if (args.action === 'move') return;
            if (args.action === 'down') {
                await currentPage.mouse.down({ button: args.button });
                return;
            }
            if (args.action === 'up') {
                await currentPage.mouse.up({ button: args.button });
                return;
            }
            if (args.action === 'wheel') {
                await currentPage.mouse.wheel(0, args.deltaY || 0);
                return;
            }
            if (args.action === 'click' || args.action === 'dblclick') {
                await currentPage.mouse.click(args.x, args.y, {
                    button: args.button,
                    clickCount: args.action === 'dblclick' ? 2 : 1,
                });
            }
        });
        if (result.ok && (args.action === 'down' || args.action === 'up' || args.action === 'click' || args.action === 'dblclick')) {
            invalidateA11yCache(base.ctx.cache, 'mouse', base.ctx.tags);
        }
        return result;
    },
});

const resolveLocator = async (
    base: ToolsBuildContext,
    args: LocatorTarget,
): Promise<Locator> => {
    if (args.role) {
        try {
            return await resolveRoleLocator(base, args.role, args.name);
        } catch (error) {
            if (args.selector) {
                return base.resolveSelectorLocator(args.selector);
            }
            throw error;
        }
    }
    if (args.selector) {
        return base.resolveSelectorLocator(args.selector);
    }
    if (!args.a11yNodeId) {
        throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
    }
    await base.ensureA11yCache();
    const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
    if (!adopted.ok) throw adopted.error;
    return adopted.data!;
};

const resolveRoleLocator = async (
    base: ToolsBuildContext,
    role: string,
    name?: string,
): Promise<Locator> => {
    const locator = base.getCurrentPage().getByRole(role as any, name ? { name } : undefined);
    const count = await locator.count();
    if (count === 0) {
        throw {
            code: 'ERR_NOT_FOUND',
            message: 'role locator not found',
            phase: 'trace',
            details: { role, name },
        };
    }
    if (count > 1) {
        throw {
            code: 'ERR_AMBIGUOUS',
            message: 'role locator matches multiple elements',
            phase: 'trace',
            details: { role, name, count },
        };
    }
    return locator.first();
};
