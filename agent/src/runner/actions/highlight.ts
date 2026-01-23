import type { Locator } from 'playwright';

export const highlightLocator = async (locator: Locator) => {
  try {
    await locator.evaluate((el: HTMLElement) => {
      el.dataset.rpaHighlight = 'true';
      el.style.outline = '2px solid #f97316';
      el.style.outlineOffset = '2px';
    });
  } catch {
    // ignore highlight failures
  }
};

export const clearHighlight = async (locator: Locator) => {
  try {
    await locator.evaluate((el: HTMLElement) => {
      if (el.dataset.rpaHighlight) {
        delete el.dataset.rpaHighlight;
      }
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  } catch {
    // ignore cleanup failures
  }
};
