import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('element_scroll', () => {
  test('page.scrollBy moves viewport', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div style="height:2000px"></div>');
    const ctx = createCtx(page, 'scroll-token');
    const res = await ctx.execute!({
      cmd: 'page.scrollBy',
      tabToken: 'scroll-token',
      args: { dx: 0, dy: 200 }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('scrollIntoView fails for missing selector', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div style="height:2000px"></div>');
    const ctx = createCtx(page, 'scroll-fail');
    const res = await ctx.execute!({
      cmd: 'element.scrollIntoView',
      tabToken: 'scroll-fail',
      args: { target: { selector: '#missing' } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
