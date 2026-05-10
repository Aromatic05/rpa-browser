import type { Page } from 'playwright';
import { getLogger } from '../../logging/logger';
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
    const recordLog = getLogger('record');
    const { event, page, snapshotCache, cacheKey } = input;
    if (!shouldUseSnapshotForEvent(event)) {
        recordLog('record_snapshot_resolve', {
            result: 'skipped',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
        });
        return undefined;
    }

    const now = Date.now();
    const cached = snapshotCache.get(cacheKey);
    if (cached && now - cached.capturedAt <= SNAPSHOT_CACHE_TTL_MS) {
        if (!page) {return cached.snapshot;}
        const pageUrl = safePageUrl(page);
        if (cached.pageUrl === pageUrl) {
            recordLog('record_snapshot_resolve', {
                result: 'hit_cache',
                eventType: event.type,
                selector: event.selector,
                cacheKey,
                snapshotId: cached.snapshot.snapshotMeta?.snapshotId,
                pageUrl,
            });
            return cached.snapshot;
        }
    }

    if (!page) {
        recordLog('record_snapshot_resolve', {
            result: 'failed',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
            reason: 'missing_page',
        });
        return undefined;
    }
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
        recordLog('record_snapshot_resolve', {
            result: 'captured',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
            snapshotId: snapshot.snapshotMeta?.snapshotId,
            pageUrl,
        });
        return snapshot;
    } catch (error) {
        const errorName = error instanceof Error ? error.name : typeof error;
        const errorMessage = error instanceof Error ? error.message : String(error);
        recordLog('record_snapshot_resolve', {
            result: 'failed',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
            pageUrl,
            reason: 'capture_failed',
            errorName,
            errorMessage,
        });
        return undefined;
    }
};
