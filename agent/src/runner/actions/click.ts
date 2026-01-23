import type { Page } from 'playwright';
import { highlightLocator, clearHighlight } from './highlight';
import { resolveTarget, resolveSelector, type Target } from './locators';

export const clickByTarget = async (
  page: Page,
  target: Target,
  delayMs: number
) => {
  const locator = await resolveTarget(page, target);
  await highlightLocator(locator);
  await page.waitForTimeout(delayMs);
  try {
    await locator.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  } finally {
    await clearHighlight(locator);
  }
};

export const clickBySelector = async (
  page: Page,
  selector: string,
  delayMs: number
) => {
  const locator = await resolveSelector(page, selector);
  await highlightLocator(locator);
  await page.waitForTimeout(delayMs);
  try {
    await locator.click();
    await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  } finally {
    await clearHighlight(locator);
  }
};
