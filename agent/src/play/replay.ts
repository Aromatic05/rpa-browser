import type { Page } from 'playwright';
import type { RecordedEvent } from '../record/recorder';
import type { Command } from '../runner/commands';
import type { Result } from '../runner/results';

export type ReplayOptions = {
  clickDelayMs: number;
  stepDelayMs: number;
  scroll: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number };
};

export const replayRecording = async (
  page: Page,
  events: RecordedEvent[],
  options: ReplayOptions,
  opts: { stopOnError: boolean },
  execute: (command: Command) => Promise<Result>
) => {
  const results: Array<Record<string, unknown>> = [];
  let pendingScroll = false;

  for (const event of events) {
    try {
      let command: Command | null = null;
      if (event.type === 'navigate' && event.url) {
        command = {
          cmd: 'page.goto',
          tabToken: event.tabToken,
          args: { url: event.url, waitUntil: 'domcontentloaded' }
        };
        pendingScroll = false;
      } else if (event.type === 'click' && event.selector) {
        if (pendingScroll) {
          await page.locator(event.selector).first().scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        command = {
          cmd: 'element.click',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, options: { timeout: 5000, noWaitAfter: true } }
        };
      } else if ((event.type === 'input' || event.type === 'change') && event.selector) {
        if (event.value === '***') {
          results.push({ ts: event.ts, ok: true, note: 'password redacted' });
          continue;
        }
        if (pendingScroll) {
          await page.locator(event.selector).first().scrollIntoViewIfNeeded();
          pendingScroll = false;
        }
        command = {
          cmd: 'element.fill',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, text: event.value || '' }
        };
      } else if (event.type === 'check' && event.selector && typeof event.checked === 'boolean') {
        command = {
          cmd: 'element.setChecked',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, checked: event.checked }
        };
      } else if (event.type === 'select' && event.selector) {
        command = {
          cmd: 'element.selectOption',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, value: event.value, label: event.label }
        };
      } else if (event.type === 'date' && event.selector && event.value) {
        command = {
          cmd: 'element.setDate',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, value: event.value }
        };
      } else if (event.type === 'paste' && event.selector) {
        if (!event.value || event.value === '***') {
          results.push({ ts: event.ts, ok: true, note: 'paste redacted' });
          continue;
        }
        command = {
          cmd: 'element.paste',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector }, text: event.value, options: { allowSensitive: true } }
        };
      } else if (event.type === 'copy' && event.selector) {
        command = {
          cmd: 'element.copy',
          tabToken: event.tabToken,
          args: { target: { selector: event.selector } }
        };
      } else if (event.type === 'keydown' && event.key) {
        command = {
          cmd: 'keyboard.press',
          tabToken: event.tabToken,
          args: { key: event.key }
        };
      } else if (event.type === 'scroll') {
        if (typeof event.scrollX === 'number' && typeof event.scrollY === 'number') {
          command = {
            cmd: 'page.scrollTo',
            tabToken: event.tabToken,
            args: { x: event.scrollX, y: event.scrollY }
          };
        } else {
          command = {
            cmd: 'page.scrollBy',
            tabToken: event.tabToken,
            args: { dx: 0, dy: options.scroll.minDelta }
          };
        }
        pendingScroll = true;
      }
      if (!command) {
        results.push({ ts: event.ts, ok: true, type: event.type, skipped: true });
        continue;
      }
      const execResult = await execute(command);
      if (!execResult.ok && opts.stopOnError) {
        results.push({ ts: event.ts, ok: false, type: event.type, error: execResult.error.message });
        return { ok: false, data: { results } };
      }
      await page.waitForTimeout(options.stepDelayMs);
      results.push({ ts: event.ts, ok: execResult.ok, type: event.type, pageUrl: page.url() });
    } catch (error) {
      results.push({
        ts: event.ts,
        ok: false,
        type: event.type,
        error: error instanceof Error ? error.message : String(error)
      });
      if (opts.stopOnError) {
        return { ok: false, data: { results } };
      }
    }
  }

  return { ok: true, data: { results } };
};
