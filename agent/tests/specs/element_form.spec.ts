import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('element_form', () => {
  test('fill writes text', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/choices.html`);
    const ctx = createCtx(page, 'form-token');
    const res = await ctx.execute!({
      cmd: 'element.fill',
      tabToken: 'form-token',
      args: { target: { selector: '#nameInput' }, text: 'hello' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#nameResult')).toHaveText('hello');
    await context.close();
  });

  test('type fails on missing selector', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/choices.html`);
    const ctx = createCtx(page, 'form-fail');
    const res = await ctx.execute!({
      cmd: 'element.type',
      tabToken: 'form-fail',
      args: { target: { selector: '#nope' }, text: 'x', options: { timeout: 200 } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
