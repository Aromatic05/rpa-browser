import {test, expect} from '@playwright/test';
import path from 'node:path';
import {startAgent} from '../../helpers/e2e_multitab_helper';
import {startFixtureServer} from '../../helpers/server';
import {startClosedBetaSession} from '../../helpers/product_closed_beta/session';
import {startClosedBetaFauxModel, planFillProgramScript} from '../../helpers/product_closed_beta/faux_model_server';
import {sendControlEval} from '../../../src/interface/control/client';

test('a beginner records, names, saves and replays using only visible page controls', async () => {
    test.setTimeout(150_000);
    const agent = await startAgent({headed:false});
    const evaluate = async (source: string) => {
        const result = await sendControlEval({source:'const activePage = ctx.resolveWorkspace("default").tabs.getActiveTab().page; let page = activePage.context().pages().find(candidate => candidate.url().includes("/rpa-practice")) ?? activePage; '+source,timeoutMs:35_000}, {endpoint:agent.endpoint,timeoutMs:40_000});
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        return result.result;
    };
    try {
        await evaluate(`
            await page.setViewportSize({width:1280,height:900});
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-home.png'))},fullPage:true});
            const newPage = page.context().waitForEvent('page');
            await page.locator('#openPractice').click();
            const startPage = page; page = await newPage;
            if (!startPage.url().includes('/newtab.html')) {throw new Error('The homepage was replaced');}
            await page.waitForURL(/rpa-practice/);
            await page.locator('[data-rpa-product-action="start-teach"]').click();
            await page.locator('[data-rpa-product-action="stop-teach"]').waitFor();
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-recording.png'))},fullPage:true});
            await page.locator('#practiceName').fill('体验用户');
            await page.locator('#practiceCategory').selectOption({label:'工作'});
            await page.locator('button[type="submit"]').click();
            await page.locator('[data-rpa-product-action="stop-teach"]').click();
            await page.locator('[data-rpa-product-field="demonstration-name"]').waitFor();
        `);
        const name = await evaluate(`
            await page.locator('[data-rpa-product-field="demonstration-name"]').pressSequentially('first-run', {delay:80});
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-review.png'))},fullPage:true});
            return page.locator('[data-rpa-product-field="demonstration-name"]').inputValue();
        `);
        expect(name).toBe('first-run');
        await evaluate(`
            await page.locator('[data-rpa-product-action="save-teach"]').click();
            await page.getByRole('button',{name:'Replay first-run',exact:true}).waitFor();
            await page.locator('button[type="reset"]').click();
            await page.getByRole('button',{name:'Replay first-run',exact:true}).click();
            try {await page.waitForFunction(() => document.getElementById('practiceResult')?.textContent === '提交成功：体验用户 / 工作',null,{timeout:10000});} catch {
                const artifact=ctx.resolveWorkspace('default').workflow.get('first-run',{kind:'recording'}); throw new Error(JSON.stringify({recording:{steps:artifact.steps,initialTabs:artifact.initialTabs,activeTabRef:artifact.activeTabRef},pages:page.context().pages().map(p=>p.url()),panel:await page.locator('[data-rpa-product-panel]').innerText(),active:ctx.resolveWorkspace('default').tabs.getActiveTab().page.url()}));
            }
            await page.locator('[data-rpa-product-playback="completed"]').waitFor();
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-replayed.png'))},fullPage:true});
        `);
    } finally {await agent.close();}
});

test('homepage opens an ordinary website with an assistant and usable help', async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent({headed:false});
    try {
        const result = await sendControlEval({timeoutMs:45_000,source: `
            let page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
            await page.locator('#websiteUrl').fill('javascript:alert(1)');
            await page.locator('#openWebsiteBtn').click();
            await page.getByRole('status').filter({hasText:'普通的 http://'}).waitFor();
            await page.locator('#websiteUrl').fill(${JSON.stringify(fixture.baseURL + '/step_actions/customer_profile.html')});
            await page.locator('#websiteMode').selectOption('ai');
            const newPage = page.context().waitForEvent('page');
            await page.locator('#openWebsiteBtn').click();
            const startPage = page; page = await newPage;
            if (!startPage.url().includes('/newtab.html')) {throw new Error('The homepage was replaced');}
            await page.waitForURL(/customer_profile.html/);
            await page.locator('[data-rpa-product-panel]').waitFor({state:'visible'});
            const currentSite = await page.locator('[data-rpa-product-surface="home"]').textContent();
            await page.locator('[data-rpa-product-action="help"]').click();
            const help = await page.locator('[data-rpa-product-surface="guide"]').textContent();
            await page.locator('[data-rpa-product-action="collapse-panel"]').click();
            const launcher = await page.locator('[data-rpa-product-launcher]').textContent();
            await page.locator('[data-rpa-product-launcher]').click();
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-other-website.png'))},fullPage:true});
            return {currentSite, help, launcher, url:page.url()};
        `}, {endpoint:agent.endpoint,timeoutMs:50_000});
        expect(result.ok, JSON.stringify(result.error)).toBe(true);
        const state = result.result as {currentSite:string;help:string;launcher:string;url:string};
        expect(state.currentSite).toContain('当前操作网站：127.0.0.1');
        expect(state.help).toContain('在其他网站上怎么用');
        expect(state.launcher).toContain('RPA 助手');
        expect(state.url).toBe(fixture.baseURL + '/step_actions/customer_profile.html');
    } finally {await agent.close();await fixture.close();}
});

test('AI input starts a real page task and shows its result using a local test model', async () => {
    test.setTimeout(150_000);
    const fixture = await startFixtureServer();
    let receivedFile = false;
    const plan = planFillProgramScript({selector:'#customerName',value:'AI体验'});
    const model = await startClosedBetaFauxModel({script: ctx => {
        if (JSON.stringify(ctx.messages).includes('录入数据.csv') && JSON.stringify(ctx.messages).includes('AI体验')) {receivedFile = true;}
        return plan(ctx);
    }});
    const session = await startClosedBetaSession({modelServer:model});
    try {
        await session.openTab(fixture.baseURL + '/step_actions/customer_profile.html');
        const result = await sendControlEval({timeoutMs:90_000,source: `
            let page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
            await page.setViewportSize({width:1280,height:900});
            await page.locator('[data-rpa-product-launcher]').click();
            await page.locator('[data-rpa-product-field="task-file"]').setInputFiles({name:'录入数据.csv',mimeType:'text/csv',buffer:Buffer.from('姓名,类别\\nAI体验,工作','utf8')});
            await page.getByText('已选择：录入数据.csv',{exact:true}).waitFor();
            await page.locator('[data-rpa-product-composer]').fill('按文件中的姓名填写当前表单，填完停下，不要提交。');
            await page.locator('[data-rpa-product-action="start"]').click();
            await page.locator('[data-rpa-product-block="result"]').waitFor({timeout:80000});
            const value = await page.locator('#customerName').inputValue();
            const outcome = await page.locator('[data-rpa-product-block="result"]').textContent();
            await page.screenshot({path: ${JSON.stringify(path.resolve('../.dev/usability-ai-result.png'))},fullPage:true});
            return {value,outcome};
        `}, {endpoint:session.endpoint,timeoutMs:95_000});
        expect(result.ok,JSON.stringify(result.error)).toBe(true);
        const state = result.result as {value:string;outcome:string};
        expect(state.value).toBe('AI体验');
        expect(receivedFile).toBe(true);
        expect(state.outcome).toContain('Task completed');
    } finally {await session.close();await model.close();await fixture.close();}
});

test('a recording remains active after full page navigation', async () => {
    test.setTimeout(120_000);
    const fixture = await startFixtureServer();
    const agent = await startAgent({headed:false});
    try {
        const result = await sendControlEval({timeoutMs:60_000,source: `
            const page = ctx.resolveWorkspace('default').tabs.getActiveTab().page;
            await page.goto(${JSON.stringify(fixture.baseURL + '/navigation_form.html')});
            await page.locator('[data-rpa-product-launcher]').click();
            await page.locator('[data-rpa-product-action="record-demo"]').click();
            await page.locator('[data-rpa-product-action="start-teach"]').click();
            await page.locator('[data-rpa-product-action="stop-teach"]').waitFor();
            await page.locator('#batchNo').fill('BATCH-1');
            await page.locator('#nextPage').click();
            await page.waitForURL(/customer_profile.html/);
            await page.locator('[data-rpa-product-launcher]').click();
            await page.locator('[data-rpa-product-action="stop-teach"]').waitFor();
            await page.locator('#customerName').fill('跨页客户');
            await page.locator('[data-rpa-product-action="stop-teach"]').click();
            await page.locator('[data-rpa-product-field="demonstration-name"]').fill('跨页录入');
            await page.locator('[data-rpa-product-action="save-teach"]').click();
            try {await page.getByRole('button',{name:'Replay 跨页录入',exact:true}).waitFor({timeout:10000});} catch {throw new Error(await page.locator('[data-rpa-product-panel]').innerText());}
            const websiteUrl = page.url();
            const startPagePromise = page.context().waitForEvent('page');
            await page.locator('[data-rpa-product-action="open-start"]').click();
            const startPage = await startPagePromise;
            await startPage.locator('#websiteUrl').waitFor();
            return {websiteUrl, homepage:startPage.url()};
        `}, {endpoint:agent.endpoint,timeoutMs:65_000});
        expect(result.ok,JSON.stringify(result.error)).toBe(true);
        expect((result.result as {homepage:string}).homepage).toContain('/newtab.html');
        expect((result.result as {websiteUrl:string}).websiteUrl).toContain('/customer_profile.html');
    } finally {await agent.close();await fixture.close();}
});
