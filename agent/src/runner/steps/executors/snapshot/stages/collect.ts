import type { Page } from 'playwright';
import { getA11yTree } from '../../../../trace/a11y/getA11yTree';
import { getDomTree } from '../../../../trace/dom/getDomTree';
import {
    cleanupTaggedRuntimeState,
    collectTaggedRuntimeState,
    createRuntimeStateEpoch,
} from '../../../../trace/runtime/getRuntimeStateMap';
import type { RawData } from '../core/types';

type CollectRawDataOptions = {
    captureRuntimeState?: boolean;
    waitMode?: SnapshotWaitMode;
};

export type SnapshotWaitMode = 'navigation' | 'interaction';

export const collectRawData = async (page: Page, options: CollectRawDataOptions = {}): Promise<RawData> => {
    await waitForSnapshotReady(page, options.waitMode || 'navigation');

    let runtimeStateMap: RawData['runtimeStateMap'];
    let runtimeStateCleanup: RawData['runtimeStateCleanup'];

    if (options.captureRuntimeState) {
        runtimeStateCleanup = async () => {
            await cleanupTaggedRuntimeState(page).catch(() => undefined);
        };
        runtimeStateMap = await collectTaggedRuntimeState(page, createRuntimeStateEpoch()).catch(() => undefined);
    }

    // 顺序约束：runtime(打标+采集) -> DOMSnapshot -> A11y。
    const domTree = await getDomTree(page);
    const a11yTree = await getA11yTree(page);

    return {
        domTree,
        a11yTree,
        runtimeStateMap,
        runtimeStateCleanup,
    };
};

export const waitForSnapshotReady = async (page: Page, mode: SnapshotWaitMode): Promise<void> => {
    const target = page as unknown as {
        waitForLoadState?: (state: 'domcontentloaded' | 'networkidle', opts?: { timeout?: number }) => Promise<void>;
        evaluate?: <T>(fn: () => Promise<T> | T) => Promise<T>;
    };

    if (mode === 'interaction') {
        await settleUiFrame(target);
        return;
    }

    await target.waitForLoadState?.('domcontentloaded', { timeout: 2500 }).catch(() => undefined);
    await settleUiFrame(target);
    await target.waitForLoadState?.('networkidle', { timeout: 1200 }).catch(() => undefined);
    await settleUiFrame(target);
};

const settleUiFrame = async (target: {
    evaluate?: <T>(fn: () => Promise<T> | T) => Promise<T>;
    waitForTimeout?: (ms: number) => Promise<void>;
}) => {
    if (typeof target.evaluate === 'function') {
        await target
            .evaluate(async () => {
                await Promise.resolve();
                const nextFrame = () =>
                    new Promise<void>((resolve) => {
                        if (typeof window.requestAnimationFrame === 'function') {
                            window.requestAnimationFrame(() => resolve());
                            return;
                        }
                        setTimeout(() => resolve(), 0);
                    });
                await nextFrame();
                await nextFrame();
            })
            .catch(() => undefined);
        return;
    }
    await target.waitForTimeout?.(32).catch(() => undefined);
};
