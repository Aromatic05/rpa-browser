import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('replay self heal', () => {
  test('fallback from css to role within scope', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/menu-replay.html`);
    const ctx = createCtx(page, 'replay-token');
    const events = [
      {
        tabToken: 'replay-token',
        ts: Date.now(),
        type: 'click',
        selector: 'aside nav.menu > a:nth-of-type(5)',
        scopeHint: 'aside',
        locatorCandidates: [
          { kind: 'css', selector: 'aside nav.menu > a:nth-of-type(5)' },
          { kind: 'role', role: 'link', name: 'Orders', exact: true },
          { kind: 'text', text: 'Orders', exact: true }
        ]
      }
    ];
    const replay = await import('../../src/play/replay');
    const res = await replay.replayRecording(page, events as any, ctx.replayOptions, { stopOnError: true }, ctx.execute!);
    expect(res.ok).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
    await context.close();
  });

  test('ambiguous candidate skipped', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/menu-replay.html`);
    const ctx = createCtx(page, 'replay-token-2');
    const events = [
      {
        tabToken: 'replay-token-2',
        ts: Date.now(),
        type: 'click',
        selector: 'a',
        scopeHint: 'aside',
        locatorCandidates: [
          { kind: 'css', selector: 'a' },
          { kind: 'role', role: 'link', name: 'Orders', exact: true }
        ]
      }
    ];
    const replay = await import('../../src/play/replay');
    const res = await replay.replayRecording(page, events as any, ctx.replayOptions, { stopOnError: true }, ctx.execute!);
    expect(res.ok).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-clicked', 'Orders');
    await context.close();
  });
});
