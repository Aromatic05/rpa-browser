import type { Page } from 'playwright';

export const gotoUrl = async (page: Page, url: string) => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
};
