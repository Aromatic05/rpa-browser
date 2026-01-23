import type { Page } from 'playwright';

const randomBetween = (min: number, max: number) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

export const performHumanScroll = async (
  page: Page,
  options: { minDelta: number; maxDelta: number; minSteps: number; maxSteps: number }
) => {
  const steps = randomBetween(options.minSteps, options.maxSteps);
  for (let i = 0; i < steps; i += 1) {
    const deltaY = randomBetween(options.minDelta, options.maxDelta);
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(randomBetween(80, 180));
  }
};
