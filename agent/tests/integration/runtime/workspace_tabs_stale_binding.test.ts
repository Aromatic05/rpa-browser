import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserContext, Page } from 'playwright';
import { createTabsControl, createWorkspaceTabs } from '../../../src/automation/runtime/workspace/tabs';
import type { RuntimeWorkspace } from '../../../src/automation/runtime/workspace/workspace';
import { createTestRecordingState } from '../../helpers/recording_state';
import type { Action } from '../../../src/interface/actions/action_protocol';

type StubPage = Page & { emitTest: (event: string, ...args: unknown[]) => void };

const createStubPage = (input: { url?: string; closed?: boolean } = {}): StubPage => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    let closed = input.closed ?? false;
    const page = {
        url: () => input.url || 'about:blank',
        isClosed: () => closed,
        close: async () => {
            closed = true;
            page.emitTest('close');
        },
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

const createTabs = () => {
    const pages: Record<string, StubPage> = {};
    return {
        pages,
        tabs: createWorkspaceTabs({
            awaitPageBinding: async (tabName) => {
                const page = pages[tabName];
                if (!page) {throw new Error(`binding missing: ${tabName}`);}
                if (page.isClosed()) {delete pages[tabName]; throw new Error(`binding closed: ${tabName}`);}
                return page;
            },
            createPageBinding: async (tabName, input) => {
                const page = createStubPage({ url: input?.startUrl });
                pages[tabName] = page;
                return page;
            },
        }),
    };
};

const stubAction = (type: string, payload: Record<string, unknown>): Action => ({
    v: 1,
    id: 'action-1',
    type,
    payload,
    at: Date.now(),
});

test('a disappeared page moves the tab to a deterministic stale state without losing identity', () => {
    const { tabs } = createTabs();
    const tab = tabs.createTab({ tabName: 'tab-1', at: 5 });
    const page = createStubPage({ url: 'https://live.test' });
    tabs.bindPage('tab-1', page);
    assert.equal(tabs.getTab('tab-1')?.binding, 'bound');

    page.emitTest('close');
    const stale = tabs.getTab('tab-1')!;
    assert.equal(stale.binding, 'stale');
    assert.equal(stale.page, null);
    assert.equal(stale.tabId, tab.tabId);
    assert.equal(stale.createdAt, 5);
    assert.equal(stale.name, 'tab-1');
});

test('rebinding a stale tab restores bound state on the same stable identity', async () => {
    const { tabs } = createTabs();
    const tab = tabs.createTab({ tabName: 'tab-1' });
    const first = createStubPage({ url: 'https://first.test' });
    tabs.bindPage('tab-1', first);
    first.close();
    assert.equal(tabs.getTab('tab-1')?.binding, 'stale');

    const replacement = createStubPage({ url: 'https://replacement.test' });
    const rebound = tabs.bindPage('tab-1', replacement);
    assert.equal(rebound?.binding, 'bound');
    assert.equal(rebound?.tabId, tab.tabId);
    assert.equal(rebound?.url, 'https://replacement.test');
});

test('binding an already closed page never reports a bound tab', () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'dead' });
    const closed = createStubPage({ closed: true });
    const tab = tabs.bindPage('dead', closed)!;
    assert.equal(tab.binding, 'stale');
    assert.equal(tab.page, null);
});

test('awaitTabPage and createTabPage deterministically rebind stale tabs', async () => {
    const { tabs, pages } = createTabs();
    const tab = tabs.createTab({ tabName: 'tab-1' });
    const page = createStubPage({ url: 'https://await.test' });
    pages['tab-1'] = page;
    assert.equal(await tabs.awaitTabPage('tab-1', 50), page);
    assert.equal(tabs.getTab('tab-1')?.binding, 'bound');
    page.close();
    assert.equal(tabs.getTab('tab-1')?.binding, 'stale');

    const refreshed = createStubPage({ url: 'https://revived.test' });
    pages['tab-1'] = refreshed;
    const awaited = await tabs.awaitTabPage('tab-1', 50);
    assert.equal(tabs.getTab('tab-1')?.binding, 'bound');
    assert.equal(tabs.getTab('tab-1')?.tabId, tab.tabId);
    assert.equal(awaited, refreshed);
});

test('multi-tab identity stays stable while one tab goes stale', async () => {
    const { tabs } = createTabs();
    const a = tabs.createTab({ tabName: 'a' });
    const b = tabs.createTab({ tabName: 'b' });
    const pageA = createStubPage({ url: 'https://a.test' });
    const pageB = createStubPage({ url: 'https://b.test' });
    tabs.bindPage('a', pageA);
    tabs.bindPage('b', pageB);
    tabs.setActiveTab('a');

    pageA.emitTest('close');
    assert.equal(tabs.getTab('a')?.binding, 'stale');
    assert.equal(tabs.getTab('b')?.binding, 'bound');
    assert.equal(tabs.resolveTab().name, 'a');
    assert.notEqual(a.tabId, b.tabId);

    const rebindA = createStubPage({ url: 'https://a2.test' });
    assert.equal(tabs.bindPage('a', rebindA)?.tabId, a.tabId);
    assert.equal(tabs.getTab('b')?.tabId, b.tabId);
});

test('closeTab detaches the page and unbinds the returned tab', async () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'first' });
    tabs.bindPage('first', createStubPage());
    tabs.createTab({ tabName: 'second' });
    tabs.setActiveTab('first');
    const closed = await tabs.closeTab('first');
    assert.equal(closed?.binding, 'unbound');
    assert.equal(closed?.page, null);
    assert.equal(tabs.hasTab('first'), false);
    assert.equal(tabs.getActiveTab()?.name, 'second');
});

test('tab.report keeps a stale tab stale and tab.list exposes deterministic binding', async () => {
    const { tabs } = createTabs();
    tabs.createTab({ tabName: 'stale-tab' });
    const page = createStubPage({ url: 'https://stale.test' });
    tabs.bindPage('stale-tab', page);
    page.close();

    tabs.reportTab('stale-tab', { url: 'https://reported.test', title: 'Ghost' });
    const tab = tabs.getTab('stale-tab')!;
    assert.equal(tab.binding, 'stale');
    assert.equal(tab.url, 'https://reported.test');

    const tabsControl = createTabsControl({ recordingState: createTestRecordingState(), navDedupeWindowMs: 1200 });
    const workspace = { name: 'ws-1', tabs, state: 'idle' } as unknown as RuntimeWorkspace;
    const result = await tabsControl.handle({
        action: stubAction('tab.list', { workspaceName: 'ws-1' }),
        workspace,
        workspaceRegistry: { getWorkspace: () => workspace },
    } as never);
    const payload = result.reply.payload as { tabs: Array<Record<string, unknown>> };
    assert.equal(payload.tabs[0].tabName, 'stale-tab');
    assert.equal(payload.tabs[0].binding, 'stale');
    assert.equal(payload.tabs[0].tabId, tab.tabId);
});
