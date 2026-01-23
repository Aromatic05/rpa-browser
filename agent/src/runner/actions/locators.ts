import type { Page } from 'playwright';

export type Target = {
  strategy?: 'css' | 'role' | 'text';
  css?: string;
  role?: string;
  name?: string;
  text?: string;
};

export const resolveTarget = async (page: Page, target?: Target) => {
  if (!target) {
    throw new Error('missing target');
  }
  let locator;
  if (target.strategy === 'css' && target.css) {
    locator = page.locator(target.css).first();
  } else if (target.role) {
    locator = page.getByRole(target.role as 'button', { name: target.name || undefined }).first();
  } else if (target.text) {
    locator = page.getByText(target.text, { exact: false }).first();
  } else {
    throw new Error('unsupported target');
  }
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator;
};

export const resolveSelector = async (page: Page, selector?: string) => {
  if (!selector) {
    throw new Error('missing selector');
  }
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 5000 });
  return locator;
};
