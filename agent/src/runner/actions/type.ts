import type { Page } from 'playwright';
import { highlightLocator, clearHighlight } from './highlight';
import { resolveTarget, resolveSelector, type Target } from './locators';

export const typeByTarget = async (
  page: Page,
  target: Target,
  text: string,
  delayMs: number
) => {
  const locator = await resolveTarget(page, target);
  await highlightLocator(locator);
  await page.waitForTimeout(delayMs);
  try {
    await locator.click({ force: true });
    await locator.fill(text);
  } finally {
    await clearHighlight(locator);
  }
};

export const typeBySelector = async (
  page: Page,
  selector: string,
  text: string,
  delayMs: number
) => {
  const locator = await resolveSelector(page, selector);
  await highlightLocator(locator);
  await page.waitForTimeout(delayMs);
  try {
    await locator.fill(text);
  } finally {
    await clearHighlight(locator);
  }
};
