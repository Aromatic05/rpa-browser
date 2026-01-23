import type { ActionHandler } from '../execute';
import type { KeyboardHotkeyCommand, KeyboardPressCommand, MouseDragAndDropCommand, MouseWheelCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';

export const keyboardMouseHandlers: Record<string, ActionHandler> = {
  'keyboard.press': async (ctx, command) => {
    const args = (command as KeyboardPressCommand).args;
    await ctx.page.keyboard.press(args.key);
    return { ok: true, tabToken: ctx.tabToken, data: { key: args.key } };
  },
  'keyboard.hotkey': async (ctx, command) => {
    const args = (command as KeyboardHotkeyCommand).args;
    for (const key of args.keys) {
      await ctx.page.keyboard.down(key);
    }
    for (const key of [...args.keys].reverse()) {
      await ctx.page.keyboard.up(key);
    }
    return { ok: true, tabToken: ctx.tabToken, data: { keys: args.keys } };
  },
  'mouse.dragAndDrop': async (ctx, command) => {
    const args = (command as MouseDragAndDropCommand).args;
    const fromResolved = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.from,
      pageRegistry: ctx.pageRegistry
    });
    const toResolved = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.to,
      pageRegistry: ctx.pageRegistry
    });
    await fromResolved.locator.scrollIntoViewIfNeeded();
    await toResolved.locator.scrollIntoViewIfNeeded();
    const fromBox = await fromResolved.locator.boundingBox();
    const toBox = await toResolved.locator.boundingBox();
    if (!fromBox || !toBox) {
      throw new Error('dragAndDrop target not visible');
    }
    await ctx.page.mouse.move(fromBox.x + fromBox.width / 2, fromBox.y + fromBox.height / 2);
    await ctx.page.mouse.down();
    await ctx.page.mouse.move(toBox.x + toBox.width / 2, toBox.y + toBox.height / 2, { steps: 10 });
    await ctx.page.mouse.up();
    return { ok: true, tabToken: ctx.tabToken, data: { from: args.from.selector, to: args.to.selector } };
  },
  'mouse.wheel': async (ctx, command) => {
    const args = (command as MouseWheelCommand).args;
    await ctx.page.mouse.wheel(args.dx, args.dy);
    return { ok: true, tabToken: ctx.tabToken, data: { dx: args.dx, dy: args.dy } };
  }
};
