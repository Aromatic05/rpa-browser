import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { createWorkspaceTabs } from '../../../src/runtime/workspace/tabs';
import { createExecutionBindings } from '../../../src/runtime/execution/bindings';
import { awaitPageBoundBinding } from '../../../src/runner/steps/helpers/runtime_binding';
import type { RunStepsDeps } from '../../../src/runner/run_steps_types';
import type { PageRegistry } from '../../../src/runtime/browser/page_registry';
import type { RuntimeWorkspace } from '../../../src/runtime/workspace/workspace';

type StubPage = Page & { emitTest: (event: string, ...args: unknown[]) => void };

const createStubPage = (input: { url?: string; closed?: boolean; closeError?: Error } = {}): StubPage => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let closed = input.closed ?? false;
    const page = {
        url: () => input.url || 'about:blank',
        isClosed: () => closed,
        close: async () => {
            if (input.closeError) {throw input.closeError;}
            closed = true;
            page.emitTest('close');
        },
        bringToFront: async () => undefined,
        on: (event: string, fn: (...args: unknown[]) => void) => {
            const current = listeners.get(event) || [];
            current.push(fn);
            listeners.set(event, current);
            return page;
        },
        off: () => page,
        context: () => ({}) as BrowserContext,
        emitTest: (event: string, ...args: unknown[]) => {
            for (const listener of listeners.get(event) || []) {listener(...args);}
        },
    } as unknown as StubPage;
    return page;
};

const createPageRegistryStub = (pages: Record<string, StubPage> = {}): PageRegistry => ({
    createPage: async () => createStubPage(),
    bindPage: async () => null,
    awaitPageBinding: async (bindingName) => {
        const page = pages[bindingName];
        if (!page) {throw new Error(`binding missing: ${bindingName}`);}
        return page;
    },
    createPageBinding: async (bindingName, input) => {
        const page = createStubPage({ url: input?.startUrl });
        pages[bindingName] = page;
        return page;
    },
    touchBinding: () => true,
    listStaleBindings: () => [],
    closePage: async () => undefined,
    debugPageBindings: async (bindingName) => ({
        bindingName,
        knownBindings: Object.keys(pages),
        knownPagesSummary: Object.values(pages).map((page) => page.url()),
        pendingClaims: [],
    }),
    createPendingBindingClaim: () => undefined,
    claimPendingBinding: async () => false,
});

const createTabs = (pages: Record<string, StubPage> = {}, touched: string[] = []) => {
    const pageRegistry = createPageRegistryStub(pages);
    return {
        pageRegistry,
        tabs: createWorkspaceTabs({
            awaitPageBinding: async (tabName, timeoutMs) =>
                await pageRegistry.awaitPageBinding(tabName, { timeoutMs }),
            createPageBinding: async (tabName, input) =>
                await pageRegistry.createPageBinding(tabName, input),
            touchBinding: (tabName) => {touched.push(tabName);},
        }),
    };
};

const createWorkspace = (
    name: string,
    tabs: ReturnType<typeof createWorkspaceTabs>,
    pageRegistry: PageRegistry,
): RuntimeWorkspace => ({
    name,
    tabs,
    browserSession: { pageRegistry },
} as unknown as RuntimeWorkspace);

test('workspace tabs create metadata and reject duplicate names', () => {
    const { tabs } = createTabs();
    const created = tabs.createTab({ tabName: 'tab-1', at: 10 });
    assert.equal(created.name, 'tab-1');
    assert.equal(created.page, null);
    assert.equal(tabs.getActiveTab()?.name, 'tab-1');
    assert.throws(() => tabs.createTab({ tabName: 'tab-1' }), /tab already exists/);
});

test('awaitTabPage binds an existing browser page to metadata', async () => {
    const page = createStubPage({ url: 'https://bound.test' });
    const { tabs } = createTabs({ 'tab-1': page });
    tabs.createTab({ tabName: 'tab-1' });
    assert.equal(await tabs.awaitTabPage('tab-1', 100), page);
    assert.equal(tabs.getTab('tab-1')?.page, page);
    assert.equal(tabs.getTab('tab-1')?.url, 'https://bound.test');
});

test('awaitTabPage reuses a live page already stored on the tab', async () => {
    const page = createStubPage({ url: 'https://live.test' });
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'tab-1' });
    tabs.bindPage('tab-1', page);
    assert.equal(await tabs.awaitTabPage('tab-1', 100), page);
});

test('createTabPage creates and binds a page through the workspace registry', async () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'tab-1' });
    const page = await tabs.createTabPage('tab-1', { startUrl: 'https://created.test' });
    assert.equal(page.url(), 'https://created.test');
    assert.equal(tabs.getTab('tab-1')?.page, page);
});

test('bindPage updates known tabs and rejects unknown metadata', () => {
    const { tabs } = createTabs();
    const page = createStubPage({ url: 'https://known.test' });
    tabs.createTab({ tabName: 'known' });
    assert.equal(tabs.bindPage('known', page)?.url, 'https://known.test');
    assert.equal(tabs.bindPage('missing', page), null);
});

test('closeTab closes its page and selects the next tab', async () => {
    const { tabs } = createTabs();
    const first = createStubPage();
    tabs.createTab({ tabName: 'first' });
    tabs.bindPage('first', first);
    tabs.createTab({ tabName: 'second' });
    tabs.setActiveTab('first');
    await tabs.closeTab('first');
    assert.equal(first.isClosed(), true);
    assert.equal(tabs.getActiveTab()?.name, 'second');
});

test('closeTab wraps page close failures', async () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'bad' });
    tabs.bindPage('bad', createStubPage({ closeError: new Error('boom') }));
    await assert.rejects(() => tabs.closeTab('bad'), /failed to close tab page: bad: boom/);
});

test('pingTab updates metadata and touches the page binding', () => {
    const touched: string[] = [];
    const { tabs } = createTabs({}, touched);
    tabs.createTab({ tabName: 'tab-1' });
    const tab = tabs.pingTab('tab-1', { url: 'https://ping.test', title: 'Ping', at: 42 });
    assert.equal(tab?.url, 'https://ping.test');
    assert.equal(tab?.title, 'Ping');
    assert.deepEqual(touched, ['tab-1']);
});

test('tab resolution uses explicit names or the active tab', () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'a' });
    tabs.createTab({ tabName: 'b' });
    tabs.setActiveTab('b');
    assert.equal(tabs.resolveTab().name, 'b');
    assert.equal(tabs.resolveTab('a').name, 'a');
    assert.throws(() => tabs.resolveTab('missing'), /tab not found/);
});

test('execution bindings bind, resolve, replace, and remove pages', async () => {
    const pageRegistry = createPageRegistryStub();
    const bindings = createExecutionBindings({ pageRegistry });
    const first = createStubPage();
    const firstBinding = bindings.bindPage({ workspaceName: 'ws', tabName: 'tab', page: first });
    assert.equal(await bindings.resolveBinding('ws', 'tab'), firstBinding);
    assert.equal(await bindings.resolveBinding('ws'), firstBinding);

    const replacement = createStubPage();
    const replacementBinding = bindings.bindPage({ workspaceName: 'ws', tabName: 'tab', page: replacement });
    assert.notEqual(replacementBinding, firstBinding);
    assert.equal(bindings.getBinding('ws', 'tab')?.page, replacement);

    replacement.emitTest('close');
    assert.equal(bindings.getBinding('ws', 'tab'), null);
    await assert.rejects(() => bindings.resolveBinding('ws'), /no active binding/);
});

test('awaitExecutableTab waits for a workspace-owned page binding', async () => {
    const page = createStubPage({ url: 'https://awaited.test' });
    const pages = { tab: page };
    const { tabs, pageRegistry } = createTabs(pages);
    tabs.createTab({ tabName: 'tab' });
    const workspace = createWorkspace('ws', tabs, pageRegistry);
    const bindings = createExecutionBindings({ pageRegistry });

    const binding = await bindings.awaitExecutableTab({
        workspace,
        pageRegistry,
        tabName: 'tab',
        timeoutMs: 100,
    });
    assert.equal(binding.page, page);
    assert.equal(tabs.getTab('tab')?.page, page);
});

test('createExecutableTab materializes metadata and a browser page', async () => {
    const { tabs, pageRegistry } = createTabs();
    const workspace = createWorkspace('ws', tabs, pageRegistry);
    const bindings = createExecutionBindings({ pageRegistry });

    const binding = await bindings.createExecutableTab({
        workspace,
        pageRegistry,
        tabName: 'new-tab',
        startUrl: 'https://entry.test',
    });
    assert.equal(binding.page.url(), 'https://entry.test');
    assert.equal(tabs.getTab('new-tab')?.page, binding.page);
    assert.equal(tabs.getActiveTab()?.name, 'new-tab');
});

test('awaitExecutableTab reuses the existing binding and preserves trace cache for the same page', async () => {
    const page = createStubPage({ url: 'https://stable-binding.test' });
    const pages = { tab: page };
    const { tabs, pageRegistry } = createTabs(pages);
    tabs.createTab({ tabName: 'tab' });
    const workspace = createWorkspace('ws', tabs, pageRegistry);
    const bindings = createExecutionBindings({ pageRegistry });

    const first = await bindings.awaitExecutableTab({
        workspace,
        pageRegistry,
        tabName: 'tab',
        timeoutMs: 100,
    });
    first.traceCtx.cache.a11yCacheGen = 42;

    const second = await bindings.awaitExecutableTab({
        workspace,
        pageRegistry,
        tabName: 'tab',
        timeoutMs: 100,
    });

    assert.equal(second, first);
    assert.equal(second.traceCtx.cache.a11yCacheGen, 42);
});

test('createExecutableTab makes the new tab active when other tabs already exist', async () => {
    const { tabs, pageRegistry } = createTabs();
    tabs.createTab({ tabName: 'existing' });
    const workspace = createWorkspace('ws', tabs, pageRegistry);
    const bindings = createExecutionBindings({ pageRegistry });

    await bindings.createExecutableTab({
        workspace,
        pageRegistry,
        tabName: 'created',
        startUrl: 'about:blank#created',
    });

    assert.equal(tabs.getActiveTab()?.name, 'created');
});

test('page binding resolution never brings the browser window to the desktop foreground', async () => {
    let bringToFrontCalls = 0;
    const page = createStubPage({url: 'https://background.test'});
    page.bringToFront = async () => { bringToFrontCalls += 1; };
    const pages = {tab: page};
    const {tabs, pageRegistry} = createTabs(pages);
    tabs.createTab({tabName: 'tab'});
    tabs.bindPage('tab', page);
    const workspace = createWorkspace('ws', tabs, pageRegistry);
    const bindings = createExecutionBindings({pageRegistry});
    const binding = bindings.bindPage({workspaceName: 'ws', tabName: 'tab', page});
    const deps = {
        resolveWorkspace: () => workspace,
        runtime: {
            awaitExecutableTab: async () => binding,
            resolveBinding: async () => binding,
        },
        config: {waitPolicy: {pageReadyTimeoutMs: 100}},
    } as unknown as RunStepsDeps;

    const resolved = await awaitPageBoundBinding(deps, 'ws', 'tab');

    assert.equal(resolved, binding);
    assert.equal(bringToFrontCalls, 0);
});
