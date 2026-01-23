import type { Page } from 'playwright';
import { resolveSelector } from './locators';

export const pressKey = async (page: Page, key: string, selector?: string) => {
  if (selector) {
    const locator = await resolveSelector(page, selector);
    await locator.press(key);
    return;
  }
  await page.keyboard.press(key);
};
