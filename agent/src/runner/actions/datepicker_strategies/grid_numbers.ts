import type { Page } from 'playwright';

export const pickFromGrid = async (page: Page, value: string) => {
  const parts = value.split('-').map((part) => Number(part));
  const day = parts[2];
  if (!day) return false;
  const locator = page
    .locator('button, [role="button"], td')
    .filter({ hasText: String(day) })
    .first();
  if (await locator.count()) {
    await locator.click();
    return true;
  }
  return false;
};
