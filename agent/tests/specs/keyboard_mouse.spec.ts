import { test, expect } from '../helpers/fixtures';
import { createStep, setupStepRunner } from '../helpers/steps';

test.describe('keyboard_mouse', () => {
    test('keyboard press triggers handler', async ({ browser }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.setContent(
            '<input id="field" aria-label="Field" /><div id="out"></div><script>document.getElementById(\"field\").addEventListener(\"keydown\", e=>{if(e.key===\"Enter\")document.getElementById(\"out\").textContent=\"ok\";});</script>',
        );
        const runner = await setupStepRunner(page, 'key-token');
        const res = await runner.run([
            createStep('browser.press_key', { key: 'Enter', selector: '#field' }),
        ]);
        expect(res.ok).toBe(true);
        await expect(page.locator('#out')).toHaveText('ok');
        await context.close();
    });

    test('dragAndDrop fails for missing target', async ({ browser, fixtureURL }) => {
        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto(`${fixtureURL}/drag.html`);
        const runner = await setupStepRunner(page, 'drag-fail');
        const res = await runner.run([
            createStep('browser.drag_and_drop', {
                sourceSelector: '#missing',
                destSelector: '#target',
            }),
        ]);
        expect(res.ok).toBe(false);
        await context.close();
    });
});
