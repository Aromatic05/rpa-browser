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

const runBatch = async (deps: any, workspaceId: string, step: ReturnType<typeof createStep>) => {
    const { checkpoint } = await runStepList(workspaceId, [step], deps, { stopOnError: true });
    expect(checkpoint.status).not.toBe('failed');
};

const bindWorkspaceToRuntime = async (
    pageRegistry: ReturnType<typeof createPageRegistry>,
    workspaceRegistry: ReturnType<typeof createWorkspaceRegistry>,
    runtimeRegistry: ReturnType<typeof createRuntimeRegistry>,
    workspaceId: string,
    tabId: string,
) => {
    const page = await pageRegistry.resolvePage({ workspaceId, tabId });
    const token = pageRegistry.resolveTabToken({ workspaceId, tabId });
    const workspace = workspaceRegistry.createWorkspace(workspaceId);
    if (!workspace.tabRegistry.hasTab(tabId)) {
        workspace.tabRegistry.createTab({ tabName: tabId, tabToken: token, page, url: page.url() });
    } else {
        workspace.tabRegistry.bindPage(tabId, page);
    }
    workspace.tabRegistry.setActiveTab(tabId);
    runtimeRegistry.bindPage({ workspaceName: workspaceId, tabName: tabId, page });
};

const createWorkspaceWithPage = async (
    pageRegistry: ReturnType<typeof createPageRegistry>,
    context: BrowserContext,
) => {
    const shell = pageRegistry.createWorkspaceShell();
    const token = crypto.randomUUID();
    const page = await context.newPage();
    await pageRegistry.bindPage(page, token);
    const bound = pageRegistry.bindTokenToWorkspace(token, shell.workspaceId);
    if (!bound) {
        throw new Error('failed to bind workspace token');
    }
    pageRegistry.setActiveWorkspace(bound.workspaceId);
    pageRegistry.setActiveTab(bound.workspaceId, bound.tabId);
    return { workspaceId: bound.workspaceId, tabId: bound.tabId };
};

test('workspace isolation & parallel', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
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
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsA.workspaceId, wsA.tabId);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, wsB.workspaceId, wsB.tabId);

    await Promise.all([
        runnerScope.run(wsA.workspaceId, () =>
            runBatch(deps, wsA.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/choices.html` })),
        ),
        runnerScope.run(wsB.workspaceId, () =>
            runBatch(deps, wsB.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/date.html` })),
        ),
    ]);

    const pageA = await pageRegistry.resolvePage({ workspaceId: wsA.workspaceId, tabId: wsA.tabId });
    const pageB = await pageRegistry.resolvePage({ workspaceId: wsB.workspaceId, tabId: wsB.tabId });
    expect(pageA.url()).toContain('/choices.html');
    expect(pageB.url()).toContain('/date.html');
    await context.close();
});

test('workspace serial queue', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
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
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceId, ws.tabId);

    const events: string[] = [];
    const task1 = runnerScope.run(ws.workspaceId, async () => {
        events.push('start1');
        await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
        events.push('end1');
    });
    const task2 = runnerScope.run(ws.workspaceId, async () => {
        events.push('start2');
        await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));
        events.push('end2');
    });

    await Promise.all([task1, task2]);
    expect(events).toEqual(['start1', 'end1', 'start2', 'end2']);
    await context.close();
});

test('multi-tab scope correctness', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
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
    const tab2 = await pageRegistry.createTab(ws.workspaceId);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceId, ws.tabId);
    await bindWorkspaceToRuntime(pageRegistry, workspaceRegistry, runtimeRegistry, ws.workspaceId, tab2);

    const tab1Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const tab2Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: tab2 });

    pageRegistry.setActiveTab(ws.workspaceId, ws.tabId);
    workspaceRegistry.getWorkspace(ws.workspaceId)?.tabRegistry.setActiveTab(ws.tabId);
    await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
    pageRegistry.setActiveTab(ws.workspaceId, tab2);
    workspaceRegistry.getWorkspace(ws.workspaceId)?.tabRegistry.setActiveTab(tab2);
    await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));

    pageRegistry.setActiveTab(ws.workspaceId, tab2);
    const activePage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId });
    expect(activePage.url()).toContain('/date.html');

    const explicitPage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    expect(explicitPage.url()).toContain('/choices.html');

    await context.close();
});
