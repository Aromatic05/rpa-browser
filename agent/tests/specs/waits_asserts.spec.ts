import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('waits_asserts', () => {
  test('assert text contains', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/choices.html`);
    const ctx = createCtx(page, 'assert-token');
    const res = await ctx.execute!({
      cmd: 'assert.text',
      tabToken: 'assert-token',
      args: { target: { selector: '#clickResult' }, contains: 'idle' }
    });
    expect(res.ok).toBe(true);
    await context.close();
  });

  test('assert visible fails', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<div id="hidden" style="display:none">hidden</div>');
    const ctx = createCtx(page, 'assert-fail');
    const res = await ctx.execute!({
      cmd: 'assert.visible',
      tabToken: 'assert-fail',
      args: { target: { selector: '#hidden' }, value: true }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
