import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';

test.describe('dialogs_popups', () => {
    test('handle next dialog', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/dialog.html`);
        const ctx = createCtx(page, 'dialog-token');
        const handle = await ctx.execute!({
            cmd: 'page.handleNextDialog',
            tabToken: 'dialog-token',
            args: { mode: 'accept' },
        });
        expect(handle.ok).toBe(true);
        const click = await ctx.execute!({
            cmd: 'element.click',
            tabToken: 'dialog-token',
            args: { target: { selector: '#confirmBtn' } },
        });
        expect(click.ok).toBe(true);
        await context.close();
    });

    test('expectPopup fails when blocked', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/choices.html`);
        const ctx = createCtx(page, 'popup-fail');
        const res = await ctx.execute!({
            cmd: 'page.expectPopup',
            tabToken: 'popup-fail',
            args: {
                action: {
                    cmd: 'element.click',
                    tabToken: 'popup-fail',
                    args: { target: { selector: '#clickMe' } },
                },
                timeout: 300,
            },
        });
        expect(res.ok).toBe(false);
        await context.close();
    });
});
