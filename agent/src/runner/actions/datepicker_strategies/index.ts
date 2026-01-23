import type { Page } from 'playwright';
import { pickByAria } from './basic_aria';
import { pickFromGrid } from './grid_numbers';

export const tryStrategies = async (page: Page, value: string) => {
  const strategies = [pickByAria, pickFromGrid];
  for (const strategy of strategies) {
    try {
      const ok = await strategy(page, value);
      if (ok) return true;
    } catch {
      // ignore and continue
    }
  }
  return false;
};
