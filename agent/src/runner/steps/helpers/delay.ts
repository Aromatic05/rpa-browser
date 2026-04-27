type WaitablePage = {
    waitForTimeout?: (timeout: number) => Promise<unknown>;
};

export const pickDelayMs = (min: number, max: number) => {
    if (!Number.isFinite(min) || !Number.isFinite(max)) {return 0;}
    if (max <= min) {return Math.max(0, min);}
    return Math.floor(min + Math.random() * (max - min + 1));
};

export const waitForHumanDelay = async (page: WaitablePage, delayMs: number) => {
    if (delayMs <= 0) {return;}
    if (typeof page.waitForTimeout === 'function') {
        await page.waitForTimeout(delayMs);
        return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
};
