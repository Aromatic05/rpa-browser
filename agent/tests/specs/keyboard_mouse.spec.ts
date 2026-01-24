import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';


test.describe('keyboard_mouse', () => {
  test('keyboard press triggers handler', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<input id="field" /><div id="out"></div><script>document.getElementById("field").addEventListener("keydown", e=>{if(e.key==="Enter")document.getElementById("out").textContent="ok";});</script>');
    await page.focus('#field');
    const ctx = createCtx(page, 'key-token');
    const res = await ctx.execute!({
      cmd: 'keyboard.press',
      tabToken: 'key-token',
      args: { key: 'Enter' }
    });
    expect(res.ok).toBe(true);
    await expect(page.locator('#out')).toHaveText('ok');
    await context.close();
  });

  test('dragAndDrop fails for missing target', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/drag.html`);
    const ctx = createCtx(page, 'drag-fail');
    const res = await ctx.execute!({
      cmd: 'mouse.dragAndDrop',
      tabToken: 'drag-fail',
      args: { from: { selector: '#missing' }, to: { selector: '#target' } }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
