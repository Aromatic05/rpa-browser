import {test, expect} from '@playwright/test';
import {startAgent} from '../../helpers/e2e_multitab_helper';
import {sendControlEval} from '../../../src/interface/control/client';

test('welcome permits no-key practice and the practice form produces a visible result', async () => {
    test.setTimeout(120_000);
    const agent = await startAgent({headed: false});
    try {
        const result = await sendControlEval({timeoutMs: 60_000, source: `
            const workspace = ctx.resolveWorkspace('default');
            const page = workspace.tabs.getActiveTab().page;
            await page.waitForURL(/newtab.html/, {timeout: 20000});
            await page.locator('#welcome').waitFor();
            await page.waitForFunction(() => document.getElementById('wsStatus')?.textContent === 'Connected');
            const initiallyHidden = await page.locator('#modelSetup').isHidden();
            await page.locator('#configureAi').click();
            await page.locator('#modelSetup').waitFor({state:'visible'});
            await page.locator('#skipModelSetup').click();
            const skipped = await page.locator('#modelSetup').isHidden();
            await page.locator('#openPractice').click();
            await page.waitForURL(/rpa-practice/);
            await page.locator('#practiceName').fill('体验用户');
            await page.locator('#practiceCategory').selectOption({label:'工作'});
            await page.locator('button[type="submit"]').click();
            const submitted = await page.locator('#practiceResult').textContent();
            await page.locator('button[type="reset"]').click();
            const reset = await page.locator('#practiceName').inputValue();
            return {initiallyHidden, skipped, submitted, reset};
        `}, {endpoint: agent.endpoint, timeoutMs: 65_000});
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        expect(result.result).toEqual({initiallyHidden:true, skipped:true, submitted:'提交成功：体验用户 / 工作', reset:''});
    } finally {await agent.close();}
});
