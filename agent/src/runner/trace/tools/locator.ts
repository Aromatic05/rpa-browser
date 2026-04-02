import { adoptA11yNode, type A11ySnapshotNode } from '../a11y/adopt';
import { invalidateA11yCache } from '../a11y/cache';
import { findA11yCandidates, type A11yCandidate } from '../a11y/find';
import { getA11yTree } from '../a11y/getA11yTree';
import type { A11yHint } from '../../steps/types';
import type { ToolsBuildContext } from './context';

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

    'trace.locator.waitForVisible': async (args: { a11yNodeId?: string; selector?: string; timeout?: number }) =>
        base.run('trace.locator.waitForVisible', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.waitFor({ state: 'visible', timeout: args.timeout });
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.waitFor({ state: 'visible', timeout: args.timeout });
        }),

    'trace.locator.scrollIntoView': async (args: { a11yNodeId?: string; selector?: string }) => {
        const result = await base.run('trace.locator.scrollIntoView', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.scrollIntoViewIfNeeded();
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.scrollIntoViewIfNeeded();
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'scroll', base.ctx.tags);
        return result;
    },

    'trace.locator.click': async (args: {
        a11yNodeId?: string;
        selector?: string;
        timeout?: number;
        button?: 'left' | 'right' | 'middle';
    }) => {
        const result = await base.run('trace.locator.click', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.click({ timeout: args.timeout, button: args.button });
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.click({ timeout: args.timeout, button: args.button });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'click', base.ctx.tags);
        return result;
    },

    'trace.locator.focus': async (args: { a11yNodeId?: string; selector?: string }) =>
        base.run('trace.locator.focus', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.focus();
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.focus();
        }),

    'trace.locator.fill': async (args: { a11yNodeId?: string; selector?: string; value: string }) => {
        const result = await base.run('trace.locator.fill', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.fill(args.value);
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.fill(args.value);
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.type': async (args: { a11yNodeId?: string; selector?: string; text: string; delayMs?: number }) => {
        const result = await base.run('trace.locator.type', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.type(args.text, { delay: args.delayMs });
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.type(args.text, { delay: args.delayMs });
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.selectOption': async (args: {
        a11yNodeId?: string;
        selector?: string;
        values: string[];
        timeout?: number;
    }) => {
        const result = await base.run('trace.locator.selectOption', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                const selected = await locator.selectOption(args.values, { timeout: args.timeout });
                return { selected };
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            const selected = await adopted.data!.selectOption(args.values, { timeout: args.timeout });
            return { selected };
        });
        if (result.ok) invalidateA11yCache(base.ctx.cache, 'input', base.ctx.tags);
        return result;
    },

    'trace.locator.hover': async (args: { a11yNodeId?: string; selector?: string }) =>
        base.run('trace.locator.hover', args, async () => {
            if (args.selector) {
                const locator = await base.resolveSelectorLocator(args.selector);
                await locator.hover();
                return;
            }
            if (!args.a11yNodeId) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing target', phase: 'trace' };
            }
            await base.ensureA11yCache();
            const adopted = await adoptA11yNode(base.getCurrentPage(), args.a11yNodeId, base.ctx.cache);
            if (!adopted.ok) throw adopted.error;
            await adopted.data!.hover();
        }),

    'trace.locator.dragDrop': async (args: {
        sourceNodeId: string;
        destNodeId?: string;
        destCoord?: { x: number; y: number };
    }) =>
        base.run('trace.locator.dragDrop', args, async () => {
            await base.ensureA11yCache();
            const currentPage = base.getCurrentPage();
            const source = await adoptA11yNode(currentPage, args.sourceNodeId, base.ctx.cache);
            if (!source.ok) throw source.error;
            if (args.destNodeId) {
                const dest = await adoptA11yNode(currentPage, args.destNodeId, base.ctx.cache);
                if (!dest.ok) throw dest.error;
                await source.data!.dragTo(dest.data!);
                return;
            }
            if (!args.destCoord) {
                throw { code: 'ERR_NOT_FOUND', message: 'missing drag destination', phase: 'trace' };
            }
            const box = await source.data!.boundingBox();
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
        action: 'move' | 'down' | 'up' | 'wheel';
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
            }
        });
        if (result.ok && (args.action === 'down' || args.action === 'up')) {
            invalidateA11yCache(base.ctx.cache, 'mouse', base.ctx.tags);
        }
        return result;
    },
});
