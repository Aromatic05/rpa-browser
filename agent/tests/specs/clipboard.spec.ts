import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('clipboard', () => {
  test('clipboard write/read', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/choices.html`);
    const ctx = createCtx(page, 'clip-token');
    const writeRes = await ctx.execute!({
      cmd: 'clipboard.write',
      tabToken: 'clip-token',
      args: { text: 'hello-clip' }
    });
    expect(writeRes.ok).toBe(true);
    const readRes = await ctx.execute!({
      cmd: 'clipboard.read',
      tabToken: 'clip-token',
      args: {}
    });
    expect(readRes.ok).toBe(true);
    if (readRes.ok) {
      expect(readRes.data.text).toContain('hello-clip');
    }
    await context.close();
  });

  test('paste requires allowSensitive', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(`${fixtureURL}/choices.html`);
    const ctx = createCtx(page, 'clip-fail');
    const res = await ctx.execute!({
      cmd: 'element.paste',
      tabToken: 'clip-fail',
      args: { target: { selector: '#nameInput' }, text: 'secret' }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
