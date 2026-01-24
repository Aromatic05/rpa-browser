import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';
import path from 'path';
import { promises as fs } from 'fs';


test.describe('file_upload', () => {
  test('set files from path', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'file-token');
    const tmpPath = path.join(process.cwd(), 'tests/fixtures/tmp.txt');
    await fs.writeFile(tmpPath, 'hello');
    const res = await ctx.execute!({
      cmd: 'element.setFilesFromPath',
      tabToken: 'file-token',
      args: { target: { selector: '#fileInput' }, paths: [tmpPath] }
    });
    expect(res.ok).toBe(true);
    await fs.unlink(tmpPath);
    await context.close();
  });

  test('set files from missing path fails', async ({ browser, baseURL }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseURL}/choices.html`);
    const ctx = createCtx(page, 'file-fail');
    const res = await ctx.execute!({
      cmd: 'element.setFilesFromPath',
      tabToken: 'file-fail',
      args: { target: { selector: '#fileInput' }, paths: ['missing.txt'] }
    });
    expect(res.ok).toBe(false);
    await context.close();
  });
});
