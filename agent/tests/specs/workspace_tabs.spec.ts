import { test, expect } from '../helpers/fixtures';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { createRuntimeRegistry } from '../../src/runtime/runtime_registry';
import { createRunnerScopeRegistry } from '../../src/runner/runner_scope';
import { createNoopHooks } from '../../src/runner/trace/hooks';
import { runStepList } from '../../src/runner/run_steps';
import { getRunnerConfig } from '../../src/runner/config';
import { createStep, createTestPluginHost } from '../helpers/steps';

const runBatch = async (deps: any, workspaceId: string, step: ReturnType<typeof createStep>) => {
    const { checkpoint } = await runStepList(workspaceId, [step], deps, { stopOnError: true });
    expect(checkpoint.status).not.toBe('failed');
};

test('workspace isolation & parallel', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () => context,
    });
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        pageRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const runnerScope = createRunnerScopeRegistry(2);

    const wsA = await pageRegistry.createWorkspace();
    const wsB = await pageRegistry.createWorkspace();

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
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        pageRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const runnerScope = createRunnerScopeRegistry(1);

    const ws = await pageRegistry.createWorkspace();

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
    const pluginHost = await createTestPluginHost();
    const runtimeRegistry = createRuntimeRegistry({
        pageRegistry,
        traceHooks: createNoopHooks(),
        pluginHost,
    });
    const deps = { runtime: runtimeRegistry, config: getRunnerConfig(), pluginHost };
    const ws = await pageRegistry.createWorkspace();
    const tab2 = await pageRegistry.createTab(ws.workspaceId);

    const tab1Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const tab2Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: tab2 });

    pageRegistry.setActiveTab(ws.workspaceId, ws.tabId);
    await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/choices.html` }));
    pageRegistry.setActiveTab(ws.workspaceId, tab2);
    await runBatch(deps, ws.workspaceId, createStep('browser.goto', { url: `${fixtureURL}/date.html` }));

    pageRegistry.setActiveTab(ws.workspaceId, tab2);
    const activePage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId });
    expect(activePage.url()).toContain('/date.html');

    const explicitPage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    expect(explicitPage.url()).toContain('/choices.html');

    await context.close();
});
