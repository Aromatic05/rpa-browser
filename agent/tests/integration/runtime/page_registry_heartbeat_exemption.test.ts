import test from 'node:test';
import assert from 'node:assert/strict';
import type {BrowserContext, Page} from 'playwright';
import {createPageRegistry} from '../../../src/automation/runtime/browser/page_registry';

type MutablePage = Page & {setUrl: (url: string) => void};

const createPage = (initialUrl: string): MutablePage => {
    let url = initialUrl;
    const listeners = new Map<string, Array<() => void>>();
    const page = {
        url: () => url,
        setUrl: (next: string) => {url = next;},
        isClosed: () => false,
        on: (event: string, listener: () => void) => {
            const current = listeners.get(event) || [];
            current.push(listener);
            listeners.set(event, current);
            return page;
        },
    } as unknown as MutablePage;
    return page;
};

const createRegistry = (page: MutablePage) => createPageRegistry({
    tabNameKey: '__rpa_tab_name',
    getContext: async () => ({pages: () => [page]}) as unknown as BrowserContext,
});

test('chrome internal and extension pages are exempt from content heartbeat expiry', async () => {
    const chromePage = createPage('chrome://settings/');
    const chromeRegistry = createRegistry(chromePage);
    await chromeRegistry.bindPage(chromePage, 'chrome-tab');

    const extensionPage = createPage('chrome-extension://start/newtab.html');
    const extensionRegistry = createRegistry(extensionPage);
    await extensionRegistry.bindPage(extensionPage, 'extension-tab');

    const farFuture = Date.now() + 60_000;
    assert.deepEqual(chromeRegistry.listStaleBindings(45_000, farFuture), []);
    assert.deepEqual(extensionRegistry.listStaleBindings(45_000, farFuture), []);
});

test('ordinary web pages still expire without content heartbeat', async () => {
    const page = createPage('https://example.com/');
    const registry = createRegistry(page);
    await registry.bindPage(page, 'web-tab');

    const farFuture = Date.now() + 60_000;
    const stale = registry.listStaleBindings(45_000, farFuture);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.bindingName, 'web-tab');
});

test('a tab becomes heartbeat-managed after navigating away from a chrome page', async () => {
    const page = createPage('chrome://newtab/');
    const registry = createRegistry(page);
    await registry.bindPage(page, 'navigated-tab');

    page.setUrl('https://example.com/app');
    const farFuture = Date.now() + 60_000;
    assert.equal(registry.listStaleBindings(45_000, farFuture)[0]?.bindingName, 'navigated-tab');
});
