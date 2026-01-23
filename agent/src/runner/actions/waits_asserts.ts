import type { ActionHandler } from '../execute';
import type { AssertCheckedCommand, AssertTextCommand, AssertVisibleCommand, WaitForSelectorCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

export const waitsAssertsHandlers: Record<string, ActionHandler> = {
  'wait.forSelector': async (ctx, command) => {
    const args = (command as WaitForSelectorCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    await locator.waitFor({ state: args.state || 'visible', timeout: args.timeout });
    return { ok: true, tabToken: ctx.tabToken, data: { state: args.state || 'visible' } };
  },
  'assert.text': async (ctx, command) => {
    const args = (command as AssertTextCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const actual = await locator.innerText();
    if (typeof args.equals === 'string' && actual !== args.equals) {
      throw new ActionError(ERROR_CODES.ERR_ASSERTION_FAILED, 'text not equal', { actual });
    }
    if (typeof args.contains === 'string' && !actual.includes(args.contains)) {
      throw new ActionError(ERROR_CODES.ERR_ASSERTION_FAILED, 'text not contains', { actual });
    }
    return { ok: true, tabToken: ctx.tabToken, data: { actual } };
  },
  'assert.checked': async (ctx, command) => {
    const args = (command as AssertCheckedCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const actual = await locator.isChecked();
    if (actual !== args.value) {
      throw new ActionError(ERROR_CODES.ERR_ASSERTION_FAILED, 'checked mismatch', { actual });
    }
    return { ok: true, tabToken: ctx.tabToken, data: { actual } };
  },
  'assert.visible': async (ctx, command) => {
    const args = (command as AssertVisibleCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const actual = await locator.isVisible();
    if (actual !== args.value) {
      throw new ActionError(ERROR_CODES.ERR_ASSERTION_FAILED, 'visible mismatch', { actual });
    }
    return { ok: true, tabToken: ctx.tabToken, data: { actual } };
  }
};
