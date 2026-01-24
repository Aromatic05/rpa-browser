import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('element_date', () => {
  test('set date on native input', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/date.html`);
    const ctx = createCtx(page, 'date-token');
    const res = await ctx.execute!({
      cmd: 'element.setDate',
      tabToken: 'date-token',
      args: { target: { selector: '#nativeDate' }, value: '2025-01-02' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#nativeDate')).toHaveValue('2025-01-02');
    await context.close();
  });

  test('set date fails when no strategy matches', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/date.html`);
    const ctx = createCtx(page, 'date-fail');
    const res = await ctx.execute!({
      cmd: 'element.setDate',
      tabToken: 'date-fail',
      args: { target: { selector: '#customDate' }, value: '2025-01-10', mode: 'picker' }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
