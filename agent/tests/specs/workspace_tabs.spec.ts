import { test, expect } from '../helpers/fixtures';
import type { BrowserContext } from '@playwright/test';
import crypto from 'node:crypto';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { createWorkspaceRegistry } from '../../src/runtime/workspace_registry';
import { createRuntimeRegistry } from '../../src/runtime/runtime_registry';
import { createRunnerScopeRegistry } from '../../src/runner/runner_scope';
import { createNoopHooks } from '../../src/runner/trace/hooks';
import { runStepList } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/config';
import { createStep, createTestPluginHost } from '../helpers/steps';

const runBatch = async (deps: any, workspaceName: string, step: ReturnType<typeof createStep>) => {
    const { checkpoint } = await runStepList(workspaceName, [step], deps, { stopOnError: true });
    expect(checkpoint.status).not.toBe('failed');
};

const bindWorkspaceToRuntime = async (
    pageRegistry: ReturnType<typeof createPageRegistry>,
    workspaceRegistry: ReturnType<typeof createWorkspaceRegistry>,
    runtimeRegistry: ReturnType<typeof createRuntimeRegistry>,
    workspaceName: string,
    tabName: string,
) => {
    const page = await pageRegistry.getPage(tabName);
    const workspace = workspaceRegistry.createWorkspace(workspaceName);
    if (!workspace.tabRegistry.hasTab(tabName)) {
        workspace.tabRegistry.createTab({ tabName: tabName, page, url: page.url() });
    } else {
        workspace.tabRegistry.bindPage(tabName, page);
    }
    workspace.tabRegistry.setActiveTab(tabName);
    runtimeRegistry.bindPage({ workspaceName: workspaceName, tabName: tabName, page });
};

const createWorkspaceWithPage = async (
    pageRegistry: ReturnType<typeof createPageRegistry>,
    context: BrowserContext,
) => {
    const workspaceName = `ws-${crypto.randomUUID()}`;
    const tabName = crypto.randomUUID();
    const page = await context.newPage();
    await pageRegistry.bindPage(page, tabName);
    return { workspaceName, tabName };
};

test('workspace isolation & parallel', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_name',
        getContext: async () => context,
    });
    const workspaceRegistry = createWorkspaceRegistry();
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        workspaceRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const runnerScope = createRunnerScopeRegistry(2);

    const wsA = await createWorkspaceWithPage(pageRegistry, context);
    const wsB = await createWorkspaceWithPage(pageRegistry, context);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsA.workspaceName, wsA.tabName);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsB.workspaceName, wsB.tabName);

    await Promise.all([
        runnerScope.run(wsA.workspaceName, () =>
            runBatch(deps, wsA.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/choices.html` })),
        ),
        runnerScope.run(wsB.workspaceName, () =>
            runBatch(deps, wsB.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/date.html` })),
        ),
    ]);

    const pageA = await pageRegistry.getPage(wsA.tabName);
    const pageB = await pageRegistry.getPage(wsB.tabName);
    expect(pageA.url()).toContain('/choices.html');
    expect(pageB.url()).toContain('/date.html');
    await context.close();
});

test('workspace serial queue', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_name',
        getContext: async () => context,
    });
    const workspaceRegistry = createWorkspaceRegistry();
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        workspaceRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const runnerScope = createRunnerScopeRegistry(1);

    const ws = await createWorkspaceWithPage(pageRegistry, context);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, ws.tabName);

    const events: string[] = [];
    const task1 = runnerScope.run(ws.workspaceName, async () => {
        events.push('start1');
        await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
        events.push('end1');
    });
    const task2 = runnerScope.run(ws.workspaceName, async () => {
        events.push('start2');
        await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));
        events.push('end2');
    });

    await Promise.all([task1, task2]);
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
    await context.close();
});

test('multi-tab scope correctness', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_name',
        getContext: async () => context,
    });
    const workspaceRegistry = createWorkspaceRegistry();
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        workspaceRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const ws = await createWorkspaceWithPage(pageRegistry, context);
    const tab2 = crypto.randomUUID();
    await pageRegistry.getPage(tab2);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, ws.tabName);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, tab2);

    workspaceRegistry.getWorkspace(ws.workspaceName)?.tabRegistry.setActiveTab(ws.tabName);
    await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
    workspaceRegistry.getWorkspace(ws.workspaceName)?.tabRegistry.setActiveTab(tab2);
    await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));

    const activePage = await pageRegistry.getPage(tab2);
    expect(activePage.url()).toContain('/date.html');

    const explicitPage = await pageRegistry.getPage(ws.tabName);
    expect(explicitPage.url()).toContain('/choices.html');

    await context.close();
});
