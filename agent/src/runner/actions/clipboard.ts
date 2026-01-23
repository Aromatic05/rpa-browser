import type { ActionHandler } from '../execute';
import type { ClipboardReadCommand, ClipboardWriteCommand, ElementCopyCommand, ElementPasteCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

const withClipboardPermission = async (page: import('playwright').Page) => {
  try {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  } catch {
    // ignore
  }
};

export const clipboardHandlers: Record<string, ActionHandler> = {
  'clipboard.write': async (ctx, command) => {
    const args = (command as ClipboardWriteCommand).args;
    await withClipboardPermission(ctx.page);
    let ok = false;
    try {
      ok = await ctx.page.evaluate(async (text) => {
        await navigator.clipboard.writeText(text);
        return true;
      }, args.text);
    } catch {
      ok = await ctx.page.evaluate((text) => {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        textarea.remove();
        return copied;
      }, args.text);
    }
    if (!ok) throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, 'clipboard write failed');
    return { ok: true, tabToken: ctx.tabToken, data: { length: args.text.length } };
  },
  'clipboard.read': async (ctx, _command) => {
    await withClipboardPermission(ctx.page);
    let text = '';
    try {
      text = await ctx.page.evaluate(async () => navigator.clipboard.readText());
    } catch {
      text = await ctx.page.evaluate(() => {
        const textarea = document.createElement('textarea');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.focus();
        const pasted = document.execCommand('paste');
        const value = textarea.value;
        textarea.remove();
        if (!pasted) {
          throw new Error('paste blocked');
        }
        return value;
      });
    }
    return { ok: true, tabToken: ctx.tabToken, data: { text } };
  },
  'element.copy': async (ctx, command) => {
    const args = (command as ElementCopyCommand).args;
    await withClipboardPermission(ctx.page);
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    await locator.click();
    await ctx.page.keyboard.press('Control+C').catch(async () => ctx.page.keyboard.press('Meta+C'));
    return { ok: true, tabToken: ctx.tabToken, data: { copied: true } };
  },
  'element.paste': async (ctx, command) => {
    const args = (command as ElementPasteCommand).args;
    const allowSensitive = args.options?.allowSensitive === true;
    if (!allowSensitive && args.text) {
      throw new ActionError(ERROR_CODES.ERR_BAD_ARGS, 'paste text requires allowSensitive');
    }
    await withClipboardPermission(ctx.page);
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    await locator.click();
    if (args.text) {
      await ctx.page.evaluate(async (text) => navigator.clipboard.writeText(text), args.text);
    }
    await ctx.page.keyboard.press('Control+V').catch(async () => ctx.page.keyboard.press('Meta+V'));
    return { ok: true, tabToken: ctx.tabToken, data: { pasted: true } };
  }
};
