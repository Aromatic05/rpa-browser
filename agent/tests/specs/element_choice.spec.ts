import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('element_choice', () => {
  test('check and select option', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'choice-token');
    const check = await ctx.execute!({
      cmd: 'element.setChecked',
      tabToken: 'choice-token',
      args: { target: { selector: '#agree' }, checked: true }
    });
    expect(check.ok).toBe(true);
    const select = await ctx.execute!({
      cmd: 'element.selectOption',
      tabToken: 'choice-token',
      args: { target: { selector: '#country' }, value: 'jp' }
    });
    expect(select.ok).toBe(true);
    await context.close();
  });

  test('select option missing fails', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'choice-fail');
    const res = await ctx.execute!({
      cmd: 'element.selectOption',
      tabToken: 'choice-fail',
      args: { target: { selector: '#country' }, value: 'missing', options: { timeout: 200 } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
