import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { collectRawData } from '../src/runner/steps/executors/snapshot/collect';

type DumpPayload = {
    sourceUrl: string;
    finalUrl: string;
    title: string;
    capturedAt: string;
    domTree: unknown;
    a11yTree: unknown;
};

const DEFAULT_URL = 'https://shop.yingdao.com/list/table-list';

const countNodes = (node: unknown): number => {
    if (!node || typeof node !== 'object') return 0;
    const children = Array.isArray((node as { children?: unknown[] }).children)
        ? ((node as { children?: unknown[] }).children as unknown[])
        : [];
    return 1 + children.reduce((sum, child) => sum + countNodes(child), 0);
};

const ensureLoggedIn = async (
    page: import('playwright').Page,
    expectedUrl: string,
): Promise<void> => {
    const loginForm = page.locator('#formLogin');
    if ((await loginForm.count()) === 0) {
        return;
    }

    const username = process.env.YINGDAO_USERNAME || 'admin';

    await page.locator('#username').fill(username);

    const getCredentialButton = page.locator('button', { hasText: '获取凭证' }).first();
    if ((await getCredentialButton.count()) > 0) {
        await getCredentialButton.click();
        for (let i = 0; i < 30; i += 1) {
            const password = await page.inputValue('#password').catch(() => '');
            if (password.trim().length > 0) {
                break;
            }
            await page.waitForTimeout(300);
        }
    }

    const loginButton = page.locator('button', { hasText: '登 录' }).first();
    const expectedPathname = (() => {
        try {
            return new URL(expectedUrl).pathname;
        } catch {
            return '';
        }
    })();

    const isReady = async (): Promise<boolean> => {
        const hasLogin = (await loginForm.count()) > 0;
        if (hasLogin) return false;

        const currentUrl = page.url();
        if (currentUrl.includes('/user/login')) return false;

        if (!expectedPathname) return true;
        return currentUrl.includes(expectedPathname);
    };

    for (let attempt = 0; attempt < 3; attempt += 1) {
        await loginButton.click();

        for (let i = 0; i < 30; i += 1) {
            if (await isReady()) {
                await page.waitForLoadState('networkidle', { timeout: 120_000 }).catch(() => undefined);
                return;
            }
            await page.waitForTimeout(300);
        }
    }

    throw new Error(`Login did not reach target page. Current URL: ${page.url()}`);
};

const main = async () => {
    const url = process.argv[2] || DEFAULT_URL;
    const outputBase =
        process.argv[3] ||
        path.resolve(process.cwd(), 'tests/fixtures/snapshot/shop.yingdao.table-list');

    const browser = await chromium.launch({ headless: true });

    try {
        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

        await ensureLoggedIn(page, url);

        const raw = await collectRawData(page);
        const payload: DumpPayload = {
            sourceUrl: url,
            finalUrl: page.url(),
            title: await page.title(),
            capturedAt: new Date().toISOString(),
            domTree: raw.domTree,
            a11yTree: raw.a11yTree,
        };

        const rawFile = `${outputBase}.raw.json`;

        await fs.mkdir(path.dirname(rawFile), { recursive: true });
        await fs.writeFile(rawFile, JSON.stringify(payload, null, 2), 'utf8');

        console.log(
            JSON.stringify(
                {
                    rawFile,
                    finalUrl: payload.finalUrl,
                    title: payload.title,
                    domCount: countNodes(payload.domTree),
                    a11yCount: countNodes(payload.a11yTree),
                },
                null,
                2,
            ),
        );
    } finally {
        await browser.close();
    }
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
