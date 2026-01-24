import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('element_click', () => {
  test('click updates UI', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'click-token');
    const res = await ctx.execute!({
      cmd: 'element.click',
      tabToken: 'click-token',
      args: { target: { selector: '#clickMe' } }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#clickResult')).toHaveText('clicked');
    await context.close();
  });

  test('click missing selector fails', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'click-fail');
    const res = await ctx.execute!({
      cmd: 'element.click',
      tabToken: 'click-fail',
      args: { target: { selector: '#does-not-exist' }, options: { timeout: 200 } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
