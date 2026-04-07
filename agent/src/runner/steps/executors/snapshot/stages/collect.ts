import type { Page } from 'playwright';
import { getA11yTree } from '../../../../trace/a11y/getA11yTree';
import { getDomTree } from '../../../../trace/dom/getDomTree';
import type { RawData } from '../core/types';

export const collectRawData = async (page: Page): Promise<RawData> => {
    await waitForSnapshotReady(page);

    // 采集入口只拼装原始数据，不在这里做复杂语义处理。
    const [domTree, a11yTree] = await Promise.all([getDomTree(page), getA11yTree(page)]);

    return {
        domTree,
        a11yTree,
    };
};

const waitForSnapshotReady = async (page: Page): Promise<void> => {
    const target = page as unknown as {
        waitForLoadState?: (state: 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }) => Promise<void>;
        waitForTimeout?: (ms: number) => Promise<void>;
        evaluate?: <T>(fn: () => T) => Promise<T>;
    };

    await target.waitForLoadState?.('domcontentloaded', { timeout: 2500 }).catch(() => undefined);
    await target.waitForTimeout?.(60).catch(() => undefined);
    await target.waitForLoadState?.('networkidle', { timeout: 1200 }).catch(() => undefined);

    if (typeof target.evaluate !== 'function') return;

    let stableHits = 0;
    for (let i = 0; i < 8; i += 1) {
        const signal = await target
            .evaluate(() => {
                const main = document.querySelector('main');
                const body = document.body;
                const interactiveCount = document.querySelectorAll(
                    'input,button,select,textarea,a[href],[role="button"],[role="textbox"]',
                ).length;
                return {
                    readyState: document.readyState,
                    interactiveCount,
                    mainNodeCount: main ? main.querySelectorAll('*').length : 0,
                    mainTextLength: (main?.innerText || '').trim().length,
                    bodyTextLength: (body?.innerText || '').trim().length,
                };
            })
            .catch(() => null);

        if (!signal) break;
        const isReadyState = signal.readyState === 'interactive' || signal.readyState === 'complete';
        const hasMainSignals =
            signal.interactiveCount > 0 ||
            signal.mainNodeCount > 40 ||
            signal.mainTextLength > 120 ||
            signal.bodyTextLength > 200;
        if (isReadyState && hasMainSignals) {
            stableHits += 1;
            if (stableHits >= 2) break;
        } else {
            stableHits = 0;
        }
        await target.waitForTimeout?.(120).catch(() => undefined);
    }
};
