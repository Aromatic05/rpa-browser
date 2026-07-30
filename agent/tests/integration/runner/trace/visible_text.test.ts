import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium, type Page} from 'playwright';
import {visibleTextEvaluation} from '../../../../src/runner/page/visible_text';

const evaluateVisibleText = async (page: Page, needle: string): Promise<unknown> =>
    await page.evaluate(
        ({expression, arg}) => {
            const evaluate = new Function('arg', `return (${expression});`) as (value: unknown) => unknown;
            const value = evaluate(arg);
            return typeof value === 'function'
                ? (value as (input: unknown) => unknown)(arg)
                : value;
        },
        visibleTextEvaluation(needle),
    );

test('visible text ignores copy inside hidden descendants', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent(`
            <main>
                <h1>当前页面</h1>
                <section>可见容器 <span id="hidden" style="display:none">恢复后的页面</span></section>
            </main>
        `);

        assert.equal(await evaluateVisibleText(page, '恢复后的页面'), false);
        await page.locator('#hidden').evaluate((element) => {
            (element as HTMLElement).style.display = 'inline';
        });
        assert.equal(await evaluateVisibleText(page, '恢复后的页面'), true);
    } finally {
        await browser.close();
    }
});

test('visible text ignores fully transparent copy', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<p id="copy" style="opacity:0">登录已失效</p>');

        assert.equal(await evaluateVisibleText(page, '登录已失效'), false);
        await page.locator('#copy').evaluate((element) => {
            (element as HTMLElement).style.opacity = '1';
        });
        assert.equal(await evaluateVisibleText(page, '登录已失效'), true);
    } finally {
        await browser.close();
    }
});
