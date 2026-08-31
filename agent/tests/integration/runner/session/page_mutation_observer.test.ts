import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { installPageMutationObserver } from '../../../../src/automation/runner/session/page_mutation';
import { PageSnapshotSessionStore } from '../../../../src/automation/snapshot/session';

const settle = async (ms = 400): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
};

test('page mutation observer coalesces a DOM burst into one notification and ignores rpa-internal capture markers', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="save">Save</button>');
        const store = new PageSnapshotSessionStore<object>();
        const pageKey: object = page;
        let notifications = 0;
        await installPageMutationObserver(page, (mutated) => {
            assert.equal(mutated, page);
            notifications += 1;
            store.markDirty(mutated, 'interaction');
        });

        // One tight DOM burst (40 mutations in a single evaluate) yields exactly
        // one coalesced notification: React/Vue-style rendering must not flood.
        await page.evaluate(() => {
            for (let index = 0; index < 40; index += 1) {
                const node = document.createElement('span');
                node.setAttribute('data-burst', String(index));
                document.body.appendChild(node);
            }
        });
        await settle();
        assert.equal(notifications, 1);

        // Snapshot capture writes data-rpa-* markers; the observer must ignore
        // the internal attribute namespace so reading the page never dirties it.
        await page.evaluate(() => {
            for (const element of document.querySelectorAll('*')) {
                element.setAttribute('data-rpa-observation-id', 'marker');
                element.setAttribute('data-rpa-state-id', 'state');
            }
        });
        await settle();
        assert.equal(notifications, 1);

        // A genuinely changed attribute is signalled.
        await page.evaluate(() => {
            document.querySelector('#save')!.setAttribute('aria-label', 'Save draft');
        });
        await settle();
        assert.equal(notifications, 2);

        // A characterData mutation is signalled as well.
        await page.evaluate(() => {
            document.querySelector('#save')!.textContent = 'Save now';
        });
        await settle();
        assert.equal(notifications, 3);
    } finally {
        await browser.close();
    }
});

test('page mutation observer survives navigation and never stacks a second observer on reinstall', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const page = await browser.newPage();
        await page.setContent('<button id="b">one</button>');
        let notifications = 0;
        await installPageMutationObserver(page, () => {
            notifications += 1;
        });

        await page.goto('data:text/html,<button id="b">two</button>');
        await settle(300);
        const beforeNavNotifications = notifications;
        await page.evaluate(() => {
            document.querySelector('#b')!.textContent = 'two-changed';
        });
        await settle();
        assert.ok(notifications > beforeNavNotifications, 'observer must be reinstalled after navigation');

        // Reinstalling on the same page is a no-op: one burst still yields one
        // notification and no second listener is stacked.
        await installPageMutationObserver(page, () => {
            notifications += 1;
        });
        const beforeReinstall = notifications;
        await page.evaluate(() => {
            document.querySelector('#b')!.textContent = 'three';
        });
        await settle();
        assert.equal(notifications - beforeReinstall, 1);
    } finally {
        await browser.close();
    }
});

test('page mutation observer does not outlive a closed page and re-registers cleanly on a new page', async () => {
    const browser = await chromium.launch({headless: true});
    try {
        const closed = await browser.newPage();
        let closedNotifications = 0;
        await installPageMutationObserver(closed, () => {
            closedNotifications += 1;
        });
        await closed.close();

        const fresh = await browser.newPage();
        await fresh.setContent('<button id="b">x</button>');
        let freshNotifications = 0;
        await installPageMutationObserver(fresh, () => {
            freshNotifications += 1;
        });
        await fresh.evaluate(() => {
            document.querySelector('#b')!.textContent = 'changed';
        });
        await settle();
        assert.equal(freshNotifications, 1);
        assert.equal(closedNotifications, 0);
    } finally {
        await browser.close();
    }
});