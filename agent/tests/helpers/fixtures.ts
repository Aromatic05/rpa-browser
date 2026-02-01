import { test as base, chromium, expect } from '@playwright/test';
import type { Browser } from '@playwright/test';
import { startFixtureServer } from './server';

type Fixtures = {
    browser: Browser;
    fixtureURL: string;
};

export const test = base.extend<Fixtures>({
    browser: [
        async ({}, use) => {
            const browser = await chromium.launch({
                headless: true,
                chromiumSandbox: false,
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });
            await use(browser);
            await browser.close();
        },
        { scope: 'worker' },
    ],
    fixtureURL: [
        async ({}, use) => {
            const server = await startFixtureServer();
            await use(server.baseURL);
            await server.close();
        },
        { scope: 'worker' },
    ],
});

export { expect };
