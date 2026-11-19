import {test, expect, chromium} from '@playwright/test';
import {promises as fs} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolvePaths} from '../../../src/automation/runtime/browser/context_manager';
import {recoverDisabledMainExtension} from '../../../src/automation/runtime/browser/extension_startup_recovery';
import {startAgent, type AgentHandle} from '../../helpers/e2e_multitab_helper';
import {sendControlEval} from '../../../src/interface/control/client';

test('disabled bundled extension recovers in the same persistent profile', async () => {
    test.setTimeout(120_000);
    const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'rpa-disabled-extension-'));
    const mainPath = resolvePaths().extensionPaths[0]!;
    const launch = () => chromium.launchPersistentContext(path.join(profile, 'workspaces', 'default'), {
        headless: true, executablePath: chromium.executablePath(),
        args: ['--disable-extensions-except=' + mainPath, '--load-extension=' + mainPath],
    });
    let context = await launch();
    let agent: AgentHandle | undefined;
    try {
        await context.addCookies([{name:'profile-preserved',value:'yes',url:'http://127.0.0.1/',expires:Math.floor(Date.now()/1000)+3600}]);
        const manager = await context.newPage();
        await manager.goto('chrome://extensions/');
        await manager.evaluate(async () => {
            const api = (globalThis as any).chrome;
            const entries = await api.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true});
            const main = entries.find((entry: any) => entry.name === 'RPA Browser');
            if (!main) {throw new Error('Main extension missing');}
            await api.management.setEnabled(main.id, false);
        });
        await context.close();
        context = await launch();
        expect(context.serviceWorkers().filter(worker => worker.url().includes('/entry/sw.js'))).toHaveLength(0);
        expect(await recoverDisabledMainExtension(context, path.join(mainPath, 'unrelated'))).toBe(false);
        await context.close();
        agent = await startAgent({headed:false,userDataDir:profile});
        const state = await sendControlEval({source: `
            const context = ctx.resolveWorkspace('default').tabs.getActiveTab().page.context();
            const welcome = context.pages().find(page => page.url().includes('/newtab.html'));
            return {welcome: !!welcome, cookie: (await context.cookies('http://127.0.0.1/')).find(cookie => cookie.name === 'profile-preserved')?.value};
        `}, {endpoint:agent.endpoint});
        expect(state.ok, JSON.stringify(state.error)).toBe(true);
        expect(state.result).toEqual({welcome:true,cookie:'yes'});
    } finally {
        await context.close();
        await agent?.close();
        await fs.rm(profile, {recursive:true,force:true,maxRetries:5});
    }
});
