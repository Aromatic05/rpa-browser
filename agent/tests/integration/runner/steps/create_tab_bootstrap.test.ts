import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { executeBrowserCreateTab } from '../../../../src/runner/steps/executors/create_tab';
import { executeBrowserGoto } from '../../../../src/runner/steps/executors/goto';
import { createWorkspaceTabs } from '../../../../src/runtime/workspace/tabs';
import type { RuntimeWorkspace } from '../../../../src/runtime/workspace/workspace';
import type { RunStepsDeps } from '../../../../src/runner/run_steps';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

const createPage = (): Page => ({
    url: () => 'chrome-extension://start/newtab.html',
    title: async () => 'Start',
    isClosed: () => false,
    bringToFront: async () => undefined,
    on: () => undefined,
    context: () => ({}),
} as unknown as Page);

const createHarness = () => {
    const page = createPage();
    const tabs = createWorkspaceTabs({
        awaitPageBinding: async () => page,
        createPageBinding: async () => page,
    });
    let createExecutableCalls = 0;
    let starts = 0;
    const workspace = {
        name: 'bootstrap-ws',
        tabs,
        browserSession: {
            pageRegistry: {} as any,
            start: async () => {
                starts += 1;
                if (!tabs.hasTab('startup-tab')) {
                    tabs.createTab({ tabName: 'startup-tab' });
                    tabs.bindPage('startup-tab', page);
                }
            },
        },
    } as unknown as RuntimeWorkspace;
    const binding = {
        workspaceName: workspace.name,
        tabName: 'startup-tab',
        pageRegistry: workspace.browserSession.pageRegistry,
        page,
        traceCtx: { cache: {} },
        traceTools: {
            'trace.page.goto': async () => ({ ok: true, data: undefined }),
        },
    } as any;
    const deps = completeRunStepsDeps({
        resolveWorkspace: () => workspace,
        runtime: {
            createExecutableTab: async () => {
                createExecutableCalls += 1;
                return binding;
            },
            awaitExecutableTab: async () => binding,
            resolveBinding: async () => binding,
        },
    }) as RunStepsDeps;
    return { workspace, deps, getStarts: () => starts, getCreateExecutableCalls: () => createExecutableCalls };
};

test('browser.create_tab reuses the browser startup tab when the workspace is empty', async () => {
    const harness = createHarness();
    const result = await executeBrowserCreateTab(
        { id: 'create', name: 'browser.create_tab', args: {}, meta: { source: 'mcp' } },
        harness.deps,
        harness.workspace.name,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.data, { tabName: 'startup-tab' });
    assert.equal(harness.workspace.tabs.listTabs().length, 1);
    assert.equal(harness.getStarts(), 1);
    assert.equal(harness.getCreateExecutableCalls(), 0);
});

test('browser.goto can bootstrap and reuse the first browser tab without create_tab', async () => {
    const harness = createHarness();
    const result = await executeBrowserGoto(
        { id: 'goto', name: 'browser.goto', args: { url: 'https://example.test' }, meta: { source: 'mcp' } },
        harness.deps,
        harness.workspace.name,
    );
    assert.equal(result.ok, true);
    assert.equal(harness.workspace.tabs.getActiveTab()?.name, 'startup-tab');
    assert.equal(harness.getStarts(), 1);
    assert.equal(harness.getCreateExecutableCalls(), 0);
});
