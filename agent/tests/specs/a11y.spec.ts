import { test, expect } from '../helpers/fixtures';
import { createCtx } from '../helpers/context';

test.describe('a11y scan', () => {
    test('detects violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-broken.html`);
        const ctx = createCtx(page, 'a11y-token');
        const res = await ctx.execute!({
            cmd: 'page.a11yScan',
            tabToken: 'a11y-token',
            args: { resultDetail: 'summary' },
        });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.data.violations.length).toBeGreaterThan(0);
        }
        await context.close();
    });

    test('ok page returns zero violations', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-ok.html`);
        const ctx = createCtx(page, 'a11y-ok');
        const res = await ctx.execute!({
            cmd: 'page.a11yScan',
            tabToken: 'a11y-ok',
            args: { resultDetail: 'summary' },
        });
        expect(res.ok).toBe(true);
        if (res.ok) {
            expect(res.data.violations.length).toBe(0);
        }
        await context.close();
    });

    test('impact filter works', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/a11y-broken.html`);
        const ctx = createCtx(page, 'a11y-filter');
        const res = await ctx.execute!({
            cmd: 'page.a11yScan',
            tabToken: 'a11y-filter',
            args: { includedImpacts: ['critical'] },
        });
        expect(res.ok).toBe(true);
        await context.close();
    });
});
