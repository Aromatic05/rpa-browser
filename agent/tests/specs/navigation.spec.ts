import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('navigation', () => {
  test('page.goto succeeds', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = createCtx(page, 'nav-token');
    const res = await ctx.execute!({
      cmd: 'page.goto',
      tabToken: 'nav-token',
      args: { url: `${fixtureURL}/choices.html`, waitUntil: 'domcontentloaded' }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('wait.forURL times out', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const ctx = createCtx(page, 'nav-timeout');
    await page.goto(`${fixtureURL}/choices.html`);
    const res = await ctx.execute!({
      cmd: 'wait.forURL',
      tabToken: 'nav-timeout',
      args: { urlOrPattern: 'not-found', timeout: 200 }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
