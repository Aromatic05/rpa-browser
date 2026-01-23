import type { ActionHandler } from '../execute';
import type { ElementSetDateCommand } from '../commands';
import { resolveTarget } from '../../runtime/target_resolver';
import { tryStrategies } from './datepicker_strategies';
import { ActionError } from '../execute';
import { ERROR_CODES } from '../error_codes';

const collectCandidates = async (page: import('playwright').Page) => {
  const nodes = await page.locator('button, [role="button"], td').evaluateAll((elements) =>
    elements.slice(0, 20).map((el) => ({
      text: (el.textContent || '').trim().slice(0, 50),
      aria: el.getAttribute('aria-label')
    }))
  );
  return nodes;
};

export const elementDateHandlers: Record<string, ActionHandler> = {
  'element.setDate': async (ctx, command) => {
    const args = (command as ElementSetDateCommand).args;
    const { locator } = await resolveTarget({
      page: ctx.page,
      tabToken: ctx.tabToken,
      target: args.target,
      pageRegistry: ctx.pageRegistry
    });
    const mode = args.mode || 'auto';
    const isDateInput = await locator.evaluate((el) => el instanceof HTMLInputElement && el.type === 'date');
    if (mode === 'input' || (mode === 'auto' && isDateInput)) {
      await locator.fill(args.value);
      await locator.evaluate((el) => {
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      });
      return { ok: true, tabToken: ctx.tabToken, data: { value: args.value } };
    }

    await locator.click();
    const ok = await tryStrategies(ctx.page, args.value);
    if (!ok) {
      const details = await collectCandidates(ctx.page);
      throw new ActionError(ERROR_CODES.ERR_UNSUPPORTED, 'datepicker strategy failed', details);
    }
    return { ok: true, tabToken: ctx.tabToken, data: { value: args.value } };
  }
};
