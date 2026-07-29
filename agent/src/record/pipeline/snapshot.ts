import type {Page} from 'playwright';
import {getLogger} from '../../logging/logger';
import {
    buildEntityRuleComponentSnapshots,
    captureControlSnapshot,
    type PageSnapshotCapture,
} from '../../snapshot';
import type {RecorderEvent} from '../capture/recorder';

export type RecordPageSnapshot = PageSnapshotCapture;

export type RecordSnapshotCacheEntry = {
    snapshot: RecordPageSnapshot;
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

export const recordSnapshotId = (snapshot: RecordPageSnapshot): string => {
    const identity = snapshot.control.observation.identity;
    return `${identity.pageEpoch}:${identity.captureRevision}`;
};

export const resolveRecordSnapshotForEvent = async (input: {
    event: RecorderEvent;
    page?: Page;
    snapshotCache: Map<string, RecordSnapshotCacheEntry>;
    cacheKey: string;
    forceFresh?: boolean;
}): Promise<RecordPageSnapshot | undefined> => {
    const recordLog = getLogger('record');
    const {event, page, snapshotCache, cacheKey} = input;
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
    if (!input.forceFresh && cached && now - cached.capturedAt <= SNAPSHOT_CACHE_TTL_MS) {
        if (!page) {return cached.snapshot;}
        const pageUrl = safePageUrl(page);
        if (cached.pageUrl === pageUrl) {
            recordLog('record_snapshot_resolve', {
                result: 'hit_cache',
                eventType: event.type,
                selector: event.selector,
                cacheKey,
                snapshotId: recordSnapshotId(cached.snapshot),
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
        const control = await captureControlSnapshot(page, {captureRuntimeState: true});
        const components = buildEntityRuleComponentSnapshots(control);
        const snapshot: RecordPageSnapshot = {
            control,
            form: components.form,
            table: components.table,
        };
        snapshotCache.set(cacheKey, {
            snapshot,
            capturedAt: Date.now(),
            pageUrl,
        });
        recordLog('record_snapshot_resolve', {
            result: 'captured',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
            snapshotId: recordSnapshotId(snapshot),
            pageUrl,
        });
        return snapshot;
    } catch (error) {
        recordLog('record_snapshot_resolve', {
            result: 'failed',
            eventType: event.type,
            selector: event.selector,
            cacheKey,
            pageUrl,
            reason: 'capture_failed',
            errorName: error instanceof Error ? error.name : typeof error,
            errorMessage: error instanceof Error ? error.message : String(error),
        });
        return undefined;
    }
};
