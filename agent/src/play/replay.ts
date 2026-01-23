import type { Page } from 'playwright';
import type { RecordedEvent } from '../record/recorder';
import { clickBySelector } from '../runner/actions/click';
import { typeBySelector } from '../runner/actions/type';
import { pressKey } from '../runner/actions/keydown';
import { gotoUrl } from '../runner/actions/navigate';
import { performHumanScroll } from '../runner/actions/scroll';
import { resolveSelector } from '../runner/actions/locators';

export type ReplayOptions = {
  clickDelayMs: number;
  stepDelayMs: number;
  scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

export const replayRecording = async (
  page: Page,
  events: RecordedEvent[],
  options: ReplayOptions
) => {
  const results: Array<Record<string, unknown>> = [];
  let pendingScroll = false;

  for (const event of events) {
    try {
      if (event.type === 'navigate' && event.url) {
        await gotoUrl(page, event.url);
        pendingScroll = false;
      } else if (event.type === 'click' && event.selector) {
        const locator = await resolveSelector(page, event.selector);
        if (pendingScroll) {
          await locator.scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        await clickBySelector(page, event.selector, options.clickDelayMs);
      } else if ((event.type === 'input' || event.type === 'change') && event.selector) {
        if (event.value === '***') {
          results.push({ ts: event.ts, ok: true, note: 'password redacted' });
          continue;
        }
        const locator = await resolveSelector(page, event.selector);
        if (pendingScroll) {
          await locator.scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        await typeBySelector(page, event.selector, event.value || '', options.clickDelayMs);
      } else if (event.type === 'keydown') {
        if (event.selector) {
          const locator = await resolveSelector(page, event.selector);
          if (pendingScroll) {
            await locator.scrollIntoViewIfNeeded();
            pendingScroll = false;
          }
          await pressKey(page, event.key || 'Enter', event.selector);
        } else if (event.key) {
          await pressKey(page, event.key);
        }
      } else if (event.type === 'scroll') {
        await performHumanScroll(page, options.scroll);
        pendingScroll = true;
        results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
        continue;
      }
      await page.waitForTimeout(options.stepDelayMs);
      results.push({ ts: event.ts, ok: true, type: event.type, pageUrl: page.url() });
    } catch (error) {
      results.push({
        ts: event.ts,
        ok: false,
        type: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
      return { ok: false, error: 'replay failed', data: { results } };
    }
  }

  return { ok: true, data: { results } };
};
