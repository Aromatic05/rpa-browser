import type { Page } from 'playwright';
import { generateSemanticSnapshot } from '../../runner/steps/executors/snapshot/pipeline/snapshot';
import type { SnapshotResult } from '../../runner/steps/executors/snapshot/core/types';
import type { RecorderEvent } from '../capture/recorder';

export type RecordSnapshotCacheEntry = {
    snapshot: SnapshotResult;
    capturedAt: number;
    pageUrl: string;
};

const SNAPSHOT_CACHE_TTL_MS = 1500;

const isPageLevelEvent = (event: RecorderEvent): boolean => event.type === 'navigate' || event.type === 'scroll';

const shouldUseSnapshotForEvent = (event: RecorderEvent): boolean => {
    if (isPageLevelEvent(event) || event.type === 'copy') {return false;}
    return true;
};

const safePageUrl = (page: Page): string => {
    try {
        return page.url();
    } catch {
        return '';
    }
};

export const resolveRecordSnapshotForEvent = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
}): Promise<SnapshotResult | undefined> => {
    const { event, page, snapshotCache, cacheKey } = input;
    if (!shouldUseSnapshotForEvent(event)) {return undefined;}

    const now = Date.now();
    const cached = snapshotCache.get(cacheKey);
    if (cached && now - cached.capturedAt <= SNAPSHOT_CACHE_TTL_MS) {
        if (!page) {return cached.snapshot;}
        const pageUrl = safePageUrl(page);
        if (cached.pageUrl === pageUrl) {
            return cached.snapshot;
        }
    }

    if (!page) {return undefined;}
    const pageUrl = safePageUrl(page);

    try {
        const snapshot = await generateSemanticSnapshot(page, {
            captureRuntimeState: true,
            waitMode: 'interaction',
        });
        snapshotCache.set(cacheKey, {
            snapshot,
            capturedAt: now,
            pageUrl,
        });
        return snapshot;
    } catch {
        return undefined;
    }
};
