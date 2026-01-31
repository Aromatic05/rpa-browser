import { test, expect } from '../helpers/fixtures';
import { createPageRegistry } from '../../src/runtime/page_registry';
import { createRecordingState } from '../../src/record/recording';
import { executeCommand, type ActionContext } from '../../src/runner/execute';
import { createRunnerScopeRegistry } from '../../src/runner/runner_scope';
import type { Command } from '../../src/runner/commands';

const buildCtx = (
    page: import('playwright').Page,
    tabToken: string,
    pageRegistry: ReturnType<typeof createPageRegistry>,
): ActionContext => {
    const ctx: ActionContext = {
        page,
        tabToken,
        pageRegistry,
        log: () => {},
        recordingState: createRecordingState(),
        replayOptions: {
            clickDelayMs: 0,
            stepDelayMs: 0,
            scroll: { minDelta: 200, maxDelta: 300, minSteps: 1, maxSteps: 2 },
        },
        navDedupeWindowMs: 300,
        execute: undefined,
    };
    ctx.execute = (cmd: Command) => executeCommand(ctx, cmd);
    return ctx;
};

test('workspace isolation & parallel', async ({ browser, fixtureURL }) => {
    const context = await browser.newContext();
    const pageRegistry = createPageRegistry({
        tabTokenKey: '__rpa_tab_token',
        getContext: async () => context,
    });
    const runnerScope = createRunnerScopeRegistry(2);

    const wsA = await pageRegistry.createWorkspace();
    const wsB = await pageRegistry.createWorkspace();

    const pageA = await pageRegistry.resolvePage({ workspaceId: wsA.workspaceId, tabId: wsA.tabId });
    const pageB = await pageRegistry.resolvePage({ workspaceId: wsB.workspaceId, tabId: wsB.tabId });
    const tabTokenA = pageRegistry.resolveTabToken({ workspaceId: wsA.workspaceId, tabId: wsA.tabId });
    const tabTokenB = pageRegistry.resolveTabToken({ workspaceId: wsB.workspaceId, tabId: wsB.tabId });

    const ctxA = buildCtx(pageA, tabTokenA, pageRegistry);
    const ctxB = buildCtx(pageB, tabTokenB, pageRegistry);

    await Promise.all([
        runnerScope.run(wsA.workspaceId, () =>
            executeCommand(ctxA, {
                cmd: 'page.goto',
                tabToken: tabTokenA,
                args: { url: `${fixtureURL}/choices.html` },
            }),
        ),
        runnerScope.run(wsB.workspaceId, () =>
            executeCommand(ctxB, {
                cmd: 'page.goto',
                tabToken: tabTokenB,
                args: { url: `${fixtureURL}/date.html` },
            }),
        ),
    ]);

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
    const runnerScope = createRunnerScopeRegistry(1);

    const ws = await pageRegistry.createWorkspace();
    const page = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const tabToken = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const ctx = buildCtx(page, tabToken, pageRegistry);

    const events: string[] = [];
    const task1 = runnerScope.run(ws.workspaceId, async () => {
        events.push('start1');
        await executeCommand(ctx, {
            cmd: 'page.goto',
            tabToken,
            args: { url: `${fixtureURL}/choices.html` },
        });
        events.push('end1');
    });
    const task2 = runnerScope.run(ws.workspaceId, async () => {
        events.push('start2');
        await executeCommand(ctx, {
            cmd: 'page.goto',
            tabToken,
            args: { url: `${fixtureURL}/date.html` },
        });
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
    const ws = await pageRegistry.createWorkspace();
    const tab2 = await pageRegistry.createTab(ws.workspaceId);

    const tab1Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const tab2Token = pageRegistry.resolveTabToken({ workspaceId: ws.workspaceId, tabId: tab2 });

    const page1 = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    const page2 = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: tab2 });

    const ctx1 = buildCtx(page1, tab1Token, pageRegistry);
    const ctx2 = buildCtx(page2, tab2Token, pageRegistry);

    await executeCommand(ctx1, {
        cmd: 'page.goto',
        tabToken: tab1Token,
        args: { url: `${fixtureURL}/choices.html` },
    });
    await executeCommand(ctx2, {
        cmd: 'page.goto',
        tabToken: tab2Token,
        args: { url: `${fixtureURL}/date.html` },
    });

    pageRegistry.setActiveTab(ws.workspaceId, tab2);
    const activePage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId });
    expect(activePage.url()).toContain('/date.html');

    const explicitPage = await pageRegistry.resolvePage({ workspaceId: ws.workspaceId, tabId: ws.tabId });
    expect(explicitPage.url()).toContain('/choices.html');

    await context.close();
});
