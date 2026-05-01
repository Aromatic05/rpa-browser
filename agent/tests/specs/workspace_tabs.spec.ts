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
    tabId: string,
) => {
    const page = await pageRegistry.resolvePage({ workspaceName, tabId });
    const token = pageRegistry.resolveTabName({ workspaceName, tabId });
    const workspace = workspaceRegistry.createWorkspace(workspaceName);
    if (!workspace.tabRegistry.hasTab(tabId)) {
        workspace.tabRegistry.createTab({ tabName: tabId, tabName: token, page, url: page.url() });
    } else {
        workspace.tabRegistry.bindPage(tabId, page);
    }
    workspace.tabRegistry.setActiveTab(tabId);
    runtimeRegistry.bindPage({ workspaceName: workspaceName, tabName: tabId, page });
};

const createWorkspaceWithPage = async (
    pageRegistry: ReturnType<typeof createPageRegistry>,
    context: BrowserContext,
) => {
    const shell = pageRegistry.createWorkspaceShell();
    const token = crypto.randomUUID();
    const page = await context.newPage();
    await pageRegistry.bindPage(page, token);
    const bound = pageRegistry.bindTokenToWorkspace(token, shell.workspaceName);
    if (!bound) {
        throw new Error('failed to bind workspace token');
    }
    pageRegistry.setActiveWorkspace(bound.workspaceName);
    pageRegistry.setActiveTab(bound.workspaceName, bound.tabId);
    return { workspaceName: bound.workspaceName, tabId: bound.tabId };
};

test('workspace isolation & parallel', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_token',
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
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsA.workspaceName, wsA.tabId);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsB.workspaceName, wsB.tabId);

    await Promise.all([
        runnerScope.run(wsA.workspaceName, () =>
            runBatch(deps, wsA.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/choices.html` })),
        ),
        runnerScope.run(wsB.workspaceName, () =>
            runBatch(deps, wsB.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/date.html` })),
        ),
    ]);

    const pageA = await pageRegistry.resolvePage({ workspaceName: wsA.workspaceName, tabId: wsA.tabId });
    const pageB = await pageRegistry.resolvePage({ workspaceName: wsB.workspaceName, tabId: wsB.tabId });
    expect(pageA.url()).toContain('/choices.html');
    expect(pageB.url()).toContain('/date.html');
    await context.close();
});

test('workspace serial queue', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabNameKey: '__rpa_tab_token',
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
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, ws.tabId);

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
        tabNameKey: '__rpa_tab_token',
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
    const tab2 = await pageRegistry.createTab(ws.workspaceName);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, ws.tabId);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceName, tab2);

    const tab1Token = pageRegistry.resolveTabName({ workspaceName: ws.workspaceName, tabId: ws.tabId });
    const tab2Token = pageRegistry.resolveTabName({ workspaceName: ws.workspaceName, tabId: tab2 });

    pageRegistry.setActiveTab(ws.workspaceName, ws.tabId);
    workspaceRegistry.getWorkspace(ws.workspaceName)?.tabRegistry.setActiveTab(ws.tabId);
    await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
    pageRegistry.setActiveTab(ws.workspaceName, tab2);
    workspaceRegistry.getWorkspace(ws.workspaceName)?.tabRegistry.setActiveTab(tab2);
    await runBatch(deps, ws.workspaceName, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));

    pageRegistry.setActiveTab(ws.workspaceName, tab2);
    const activePage = await pageRegistry.resolvePage({ workspaceName: ws.workspaceName });
    expect(activePage.url()).toContain('/date.html');

    const explicitPage = await pageRegistry.resolvePage({ workspaceName: ws.workspaceName, tabId: ws.tabId });
    expect(explicitPage.url()).toContain('/choices.html');

    await context.close();
});
