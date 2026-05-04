import test from 'node:test';
import assert from 'node:assert/strict';
import type { Page, BrowserContext } from 'playwright';
import { createWorkspaceTabs } from '../../src/runtime/workspace/tabs';
import { createExecutionBindings } from '../../src/runtime/execution/bindings';

const createStubPage = (overrides?: Partial<Page>): Page => {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    return {
        url: () => 'about:blank',
        isClosed: () => false,
        close: async () => undefined,
        on: ((event: string, fn: (...args: unknown[]) => void) => {
            const existing = listeners.get(event) ?? [];
            existing.push(fn);
            listeners.set(event, existing);
        }) as Page['on'],
        off: (() => undefined) as unknown as Page['off'],
        context: () => ({}) as BrowserContext,
        _emit: (event: string, ...args: unknown[]) => {
            listeners.get(event)?.forEach((fn) => fn(...args));
        },
        ...overrides,
    } as unknown as Page;
};

// ── WorkspaceTabs ──

test('createTab adds a tab and sets it as active when first', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    const tab = tabs.createTab({ tabName: 'tab-1' });
    assert.equal(tab.name, 'tab-1');
    assert.equal(tab.page, null);
    assert.equal(tabs.getActiveTab()?.name, 'tab-1');
    assert.equal(tabs.hasTab('tab-1'), true);
});

test('createTab throws on duplicate name', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'tab-1' });
    assert.throws(() => tabs.createTab({ tabName: 'tab-1' }), /tab already exists/);
});

test('createMetadataTab creates a tab via createTab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    const tab = tabs.createMetadataTab({ tabName: 'meta-tab', url: 'https://x.com', title: 'X' });
    assert.equal(tab.name, 'meta-tab');
    assert.equal(tab.url, 'https://x.com');
    assert.equal(tab.title, 'X');
});

test('ensurePage creates page when tab does not exist', async () => {
    const stubPage = createStubPage({ url: () => 'https://stub.io' });
    const tabs = createWorkspaceTabs({ getPage: async () => stubPage });
    const page = await tabs.ensurePage('new-tab');
    assert.equal(page, stubPage);
    assert.equal(tabs.hasTab('new-tab'), true);
    assert.equal(tabs.getTab('new-tab')?.url, 'https://stub.io');
});

test('ensurePage reuses existing page when not closed', async () => {
    const stubPage = createStubPage({ url: () => 'https://alive.io', isClosed: () => false });
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'alive-tab', page: stubPage });
    const page = await tabs.ensurePage('alive-tab');
    assert.equal(page, stubPage);
});

test('ensurePage replaces closed page with a new one', async () => {
    const newPage = createStubPage({ url: () => 'https://replaced.io' });
    let called = false;
    const tabs = createWorkspaceTabs({
        getPage: async () => {
            called = true;
            return newPage;
        },
    });
    tabs.createTab({ tabName: 'dead-tab', page: createStubPage({ isClosed: () => true }) });
    const page = await tabs.ensurePage('dead-tab');
    assert.equal(called, true);
    assert.equal(page, newPage);
    assert.equal(tabs.getTab('dead-tab')?.url, 'https://replaced.io');
});

test('bindPage updates an existing tab with a new page', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'orphan' });
    const page = createStubPage({ url: () => 'https://bound.io' });
    const result = tabs.bindPage('orphan', page);
    assert.notEqual(result, null);
    assert.equal(result!.page, page);
    assert.equal(result!.url, 'https://bound.io');
});

test('bindPage returns null for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    const result = tabs.bindPage('ghost', createStubPage());
    assert.equal(result, null);
});

test('closeTab removes tab and clears active when last', async () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'only' });
    const closed = await tabs.closeTab('only');
    assert.equal(closed?.name, 'only');
    assert.equal(tabs.hasTab('only'), false);
    assert.equal(tabs.getActiveTab(), null);
});

test('closeTab closes the real page when present', async () => {
    let closed = false;
    const page = createStubPage({
        close: async () => { closed = true; },
    });
    const tabs = createWorkspaceTabs({ getPage: async () => page });
    tabs.createTab({ tabName: 'page-tab', page });
    await tabs.closeTab('page-tab');
    assert.equal(closed, true);
});

test('closeTab returns null for unknown tab', async () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    const result = await tabs.closeTab('ghost');
    assert.equal(result, null);
});

test('closeTab selects next available tab as active', async () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'first' });
    tabs.createTab({ tabName: 'second' });
    tabs.setActiveTab('first');
    await tabs.closeTab('first');
    assert.equal(tabs.getActiveTab()?.name, 'second');
});

test('closeTab wraps page close errors', async () => {
    const page = createStubPage({
        close: async () => { throw new Error('boom'); },
    });
    const tabs = createWorkspaceTabs({ getPage: async () => page });
    tabs.createTab({ tabName: 'bad', page });
    await assert.rejects(() => tabs.closeTab('bad'), /failed to close tab page: bad: boom/);
});

test('listTabs returns all tabs', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'a' });
    tabs.createTab({ tabName: 'b' });
    const list = tabs.listTabs();
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((t) => t.name).sort(), ['a', 'b']);
});

test('setActiveTab throws for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.throws(() => tabs.setActiveTab('ghost'), /tab not found/);
});

test('getActiveTab returns null when no tabs', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.getActiveTab(), null);
});

test('hasTab returns false for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.hasTab('ghost'), false);
});

test('getTab returns null for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.getTab('ghost'), null);
});

test('resolveTab returns the named tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'target' });
    tabs.createTab({ tabName: 'other' });
    assert.equal(tabs.resolveTab('target').name, 'target');
});

test('resolveTab falls back to active tab when name omitted', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'first' });
    tabs.createTab({ tabName: 'second' });
    tabs.setActiveTab('second');
    assert.equal(tabs.resolveTab(undefined).name, 'second');
});

test('resolveTab throws when active tab is missing', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.throws(() => tabs.resolveTab(undefined), /active tab not found/);
});

test('resolveTab throws for unknown tab name', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.throws(() => tabs.resolveTab('ghost'), /tab not found/);
});

test('updateTab patches url, title, and updatedAt', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 't' });
    const updated = tabs.updateTab('t', { url: 'https://new.io', title: 'N' });
    assert.notEqual(updated, null);
    assert.equal(updated!.url, 'https://new.io');
    assert.equal(updated!.title, 'N');
    assert.ok(updated!.updatedAt > 0);
});

test('updateTab returns null for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.updateTab('ghost', { title: 'Nope' }), null);
});

test('reportTab updates fields for known tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'r' });
    const result = tabs.reportTab('r', { url: 'https://r.io', title: 'R' });
    assert.notEqual(result, null);
    assert.equal(result!.url, 'https://r.io');
    assert.equal(result!.title, 'R');
});

test('reportTab returns null for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.reportTab('ghost', {}), null);
});

test('pingTab updates fields for known tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'p' });
    const result = tabs.pingTab('p', { url: 'https://p.io' });
    assert.notEqual(result, null);
    assert.equal(result!.url, 'https://p.io');
});

test('pingTab returns null for unknown tab', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    assert.equal(tabs.pingTab('ghost', {}), null);
});

test('reassignTab creates tab if missing and sets it active', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    const tab = tabs.reassignTab('fresh', { at: 999 });
    assert.equal(tab.name, 'fresh');
    assert.equal(tab.createdAt, 999);
    assert.equal(tabs.getActiveTab()?.name, 'fresh');
});

test('reassignTab sets active without changing existing tab data', () => {
    const tabs = createWorkspaceTabs({ getPage: async () => createStubPage() });
    tabs.createTab({ tabName: 'existing', url: 'https://keep.me' });
    tabs.createTab({ tabName: 'other' });
    const tab = tabs.reassignTab('existing', {});
    assert.equal(tab.url, 'https://keep.me');
    assert.equal(tabs.getActiveTab()?.name, 'existing');
});

// ── ExecutionBindings ──

test('bindPage creates a binding and returns it', () => {
    const bindings = createExecutionBindings({});
    const page = createStubPage();
    const binding = bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    assert.equal(binding.workspaceName, 'ws-1');
    assert.equal(binding.tabName, 't1');
    assert.equal(binding.page, page);
    assert.ok(binding.traceTools);
    assert.ok(binding.traceCtx);
});

test('bindPage returns existing binding when same page is re-bound', () => {
    const bindings = createExecutionBindings({});
    const page = createStubPage();
    const first = bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    const second = bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    assert.equal(first, second);
});

test('bindPage creates a new binding when page differs', () => {
    const bindings = createExecutionBindings({});
    const page1 = createStubPage();
    const page2 = createStubPage();
    const first = bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page: page1 });
    const second = bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page: page2 });
    assert.notEqual(first, second);
});

test('getBinding returns the binding for workspace + tab', () => {
    const bindings = createExecutionBindings({});
    const page = createStubPage();
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    const found = bindings.getBinding('ws-1', 't1');
    assert.notEqual(found, null);
    assert.equal(found!.workspaceName, 'ws-1');
});

test('getBinding returns null for unknown workspace/tab', () => {
    const bindings = createExecutionBindings({});
    assert.equal(bindings.getBinding('ws-1', 'ghost'), null);
});

test('resolveBinding returns the active tab when tabName is omitted', async () => {
    const bindings = createExecutionBindings({});
    const page = createStubPage();
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    const resolved = await bindings.resolveBinding('ws-1');
    assert.equal(resolved.tabName, 't1');
});

test('resolveBinding returns specific tab when tabName is provided', async () => {
    const bindings = createExecutionBindings({});
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page: createStubPage() });
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't2', page: createStubPage() });
    const resolved = await bindings.resolveBinding('ws-1', 't2');
    assert.equal(resolved.tabName, 't2');
});

test('resolveBinding throws when no binding exists', async () => {
    const bindings = createExecutionBindings({});
    await assert.rejects(() => bindings.resolveBinding('ghost'), /page not bound/);
});

test('resolveBinding throws when tabName is provided but not found', async () => {
    const bindings = createExecutionBindings({});
    await assert.rejects(() => bindings.resolveBinding('ws-1', 'ghost'), /page not bound/);
});

test('resolveBinding falls back to remaining tab when active is unset', async () => {
    const bindings = createExecutionBindings({});
    const page = createStubPage();
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page });
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't2', page: createStubPage() });
    // Simulate active being cleared by emitting close on the active tab's page
    page._emit('close');
    const resolved = await bindings.resolveBinding('ws-1');
    assert.equal(resolved.tabName, 't2');
});

test('bindPage with different page for same key replaces binding', () => {
    const bindings = createExecutionBindings({});
    const page1 = createStubPage();
    const page2 = createStubPage();
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page: page1 });
    bindings.bindPage({ workspaceName: 'ws-1', tabName: 't1', page: page2 });
    const binding = bindings.getBinding('ws-1', 't1');
    assert.equal(binding!.page, page2);
});
