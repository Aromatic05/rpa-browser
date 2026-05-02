import type { PageBinding } from '../../../../../runtime/runtime_registry';
import { snapshotDebugLog } from './debug';
import { applySnapshotOverlay, buildFinalEntityViewFromSnapshot } from './overlay';
import { cloneTreeWithRuntime, normalizeText } from './runtime_store';
import type {
    SnapshotDiffBaselineEntry,
    SnapshotOverlays,
    SnapshotPageIdentity,
    SnapshotResult,
    SnapshotSessionEntry,
    SnapshotSessionStore,
} from './types';

const STORE_KEY = 'snapshotSessionStore';
const DEFAULT_STORE_VERSION = 1;
const DEFAULT_SNAPSHOT_TTL_MS = 20_000;
const MAX_DIFF_BASELINE_COUNT = 64;
const DIRTY_STEP_NAMES = new Set<string>([
    'browser.goto',
    'browser.reload',
    'browser.go_back',
    'browser.click',
    'browser.fill',
    'browser.type',
    'browser.select_option',
    'browser.press_key',
    'browser.drag_and_drop',
]);

const CONDITIONAL_DIRTY_STEP_NAMES = new Set<string>(['browser.evaluate']);

type TraceSnapshotCache = Record<string, unknown> & {
    latestSnapshot?: unknown;
    latestSnapshotAt?: number;
    snapshotSessionStore?: unknown;
};

type EnsureFreshSnapshotOptions = {
    forceRefresh?: boolean;
    ttlMs?: number;
    refreshReason?: string;
    collectBaseSnapshot: (context: {
        reason: string;
        fromDirty: boolean;
        staleReason?: string;
    }) => Promise<SnapshotResult>;
};

type EnsureFreshSnapshotResult = {
    entry: SnapshotSessionEntry;
    snapshot: SnapshotResult;
    refreshed: boolean;
    refreshReason?: string;
};

type ShouldRefreshSnapshotOptions = {
    forceRefresh?: boolean;
    ttlMs?: number;
    pageIdentityChanged?: boolean;
};

type ShouldRefreshSnapshotResult = {
    refresh: boolean;
    reason?: string;
};

const getSnapshotSessionStore = (binding: PageBinding): SnapshotSessionStore => {
    const cache = binding.traceCtx.cache as TraceSnapshotCache;
    const raw = cache[STORE_KEY];
    if (isSnapshotSessionStore(raw)) {
        cache.snapshotSessionStore = raw;
        return raw;
    }

    const store: SnapshotSessionStore = {
        version: DEFAULT_STORE_VERSION,
        entries: {},
    };
    cache[STORE_KEY] = store;
    cache.snapshotSessionStore = store;
    return store;
};

const getSnapshotSessionEntryKey = (binding: PageBinding): string => {
    return `${binding.workspaceName}:${binding.tabName}`;
};

export const getSnapshotSessionEntry = (binding: PageBinding): SnapshotSessionEntry | undefined => {
    const store = getSnapshotSessionStore(binding);
    return store.entries[getSnapshotSessionEntryKey(binding)];
};

export const ensureSnapshotSessionEntry = (binding: PageBinding): SnapshotSessionEntry => {
    const store = getSnapshotSessionStore(binding);
    const key = getSnapshotSessionEntryKey(binding);
    if (Object.prototype.hasOwnProperty.call(store.entries, key)) {
        const existing = store.entries[key];
        syncPageIdentity(existing, resolveSnapshotPageIdentity(binding));
        return existing;
    }
    const existing = store.entries[key];

    const entry = createSnapshotSessionEntry(resolveSnapshotPageIdentity(binding));
    store.entries[key] = entry;
    return entry;
};

export const markSnapshotSessionDirty = (binding: PageBinding, source: string): void => {
    const entry = ensureSnapshotSessionEntry(binding);
    entry.dirty = true;
    entry.lastDirtyAt = Date.now();
    entry.staleReason = source;
    entry.version = (entry.version || 0) + 1;

    snapshotDebugLog('cache-dirty', {
        key: getSnapshotSessionEntryKey(binding),
        source,
        dirty: entry.dirty,
    });
};

export const shouldMarkSnapshotDirtyByStep = (
    stepName: string,
    stepArgs: Record<string, unknown> | undefined,
): boolean => {
    if (DIRTY_STEP_NAMES.has(stepName)) {return true;}
    if (CONDITIONAL_DIRTY_STEP_NAMES.has(stepName)) {
        return stepArgs?.mutatesPage === true;
    }
    return false;
};

const shouldRefreshSnapshot = (
    entry: SnapshotSessionEntry,
    options: ShouldRefreshSnapshotOptions,
): ShouldRefreshSnapshotResult => {
    if (options.forceRefresh) {
        return { refresh: true, reason: 'explicit-refresh' };
    }
    if (options.pageIdentityChanged) {
        return { refresh: true, reason: 'page-identity-changed' };
    }
    if (!entry.baseSnapshot) {
        return { refresh: true, reason: 'base-missing' };
    }
    if (entry.dirty) {
        return { refresh: true, reason: entry.staleReason || 'dirty' };
    }
    if (isSnapshotTtlExpired(entry, options.ttlMs)) {
        return { refresh: true, reason: 'ttl-expired' };
    }
    return { refresh: false };
};

export const ensureFreshSnapshot = async (
    binding: PageBinding,
    options: EnsureFreshSnapshotOptions,
): Promise<EnsureFreshSnapshotResult> => {
    const entry = ensureSnapshotSessionEntry(binding);
    const identityChanged = syncPageIdentity(entry, resolveSnapshotPageIdentity(binding));
    const refreshDecision = shouldRefreshSnapshot(entry, {
        forceRefresh: options.forceRefresh,
        ttlMs: options.ttlMs,
        pageIdentityChanged: identityChanged,
    });

    if (!refreshDecision.refresh) {
        const snapshot = ensureComposedSnapshot(entry);
        setLatestSnapshotCache(binding, snapshot);
        snapshotDebugLog('cache-hit', {
            key: getSnapshotSessionEntryKey(binding),
            dirty: entry.dirty,
            lastRefreshAt: entry.lastRefreshAt,
            overlaySummary: summarizeOverlays(entry.overlays),
        });
        return {
            entry,
            snapshot,
            refreshed: false,
        };
    }

    snapshotDebugLog('cache-miss', {
        key: getSnapshotSessionEntryKey(binding),
        reason: refreshDecision.reason,
        dirty: entry.dirty,
        hasBaseSnapshot: Boolean(entry.baseSnapshot),
    });

    if (entry.refreshInFlight) {
        snapshotDebugLog('cache-refresh-wait', {
            key: getSnapshotSessionEntryKey(binding),
            reason: refreshDecision.reason,
        });
        await entry.refreshInFlight;
        const snapshot = ensureComposedSnapshot(entry);
        setLatestSnapshotCache(binding, snapshot);
        return {
            entry,
            snapshot,
            refreshed: true,
            refreshReason: 'refresh-in-flight',
        };
    }

    const refreshReason = options.refreshReason || refreshDecision.reason || 'refresh';
    snapshotDebugLog('cache-refresh', {
        key: getSnapshotSessionEntryKey(binding),
        reason: refreshReason,
        dirty: entry.dirty,
        staleReason: entry.staleReason,
        overlaySummary: summarizeOverlays(entry.overlays),
    });

    const fromDirty = entry.dirty;
    entry.refreshInFlight = options.collectBaseSnapshot({
        reason: refreshReason,
        fromDirty,
        staleReason: entry.staleReason,
    });
    try {
        const baseSnapshot = await entry.refreshInFlight;
        entry.baseSnapshot = baseSnapshot;
        entry.lastRefreshAt = Date.now();
        entry.dirty = false;
        entry.staleReason = undefined;
        entry.version = (entry.version || 0) + 1;

        composeFinalFromBase(entry);
        const snapshot = ensureComposedSnapshot(entry);
        setLatestSnapshotCache(binding, snapshot);

        snapshotDebugLog('cache-refresh-done', {
            key: getSnapshotSessionEntryKey(binding),
            refreshedAt: entry.lastRefreshAt,
            overlaySummary: summarizeOverlays(entry.overlays),
        });

        return {
            entry,
            snapshot,
            refreshed: true,
            refreshReason,
        };
    } finally {
        entry.refreshInFlight = undefined;
    }
};

export const updateSnapshotOverlays = (
    binding: PageBinding,
    source: string,
    mutator: (overlays: SnapshotOverlays) => void,
): SnapshotSessionEntry => {
    const entry = ensureSnapshotSessionEntry(binding);
    mutator(entry.overlays);
    entry.version = (entry.version || 0) + 1;
    composeFinalFromBase(entry);

    const snapshot = entry.finalSnapshot || entry.baseSnapshot;
    if (snapshot) {
        setLatestSnapshotCache(binding, snapshot);
    }

    snapshotDebugLog('overlay-update', {
        key: getSnapshotSessionEntryKey(binding),
        source,
        overlaySummary: summarizeOverlays(entry.overlays),
        hasBaseSnapshot: Boolean(entry.baseSnapshot),
        hasFinalSnapshot: Boolean(entry.finalSnapshot),
    });

    return entry;
};

export const readSnapshotDiffBaseline = (
    entry: SnapshotSessionEntry,
    key: string,
): SnapshotDiffBaselineEntry | undefined => {
    const map = ensureDiffBaselineMap(entry);
    if (!Object.prototype.hasOwnProperty.call(map, key)) {return undefined;}
    const baseline = map[key];
    return {
        snapshotId: baseline.snapshotId,
        root: cloneTreeWithRuntime(baseline.root),
        createdAt: baseline.createdAt,
        pageIdentity: {
            workspaceName: baseline.pageIdentity.workspaceName,
            tabName: baseline.pageIdentity.tabName,
            url: baseline.pageIdentity.url,
        },
    };
};

export const writeSnapshotDiffBaseline = (
    entry: SnapshotSessionEntry,
    key: string,
    baseline: SnapshotDiffBaselineEntry,
): void => {
    const map = ensureDiffBaselineMap(entry);
    map[key] = {
        snapshotId: baseline.snapshotId,
        root: cloneTreeWithRuntime(baseline.root),
        createdAt: baseline.createdAt,
        pageIdentity: {
            workspaceName: baseline.pageIdentity.workspaceName,
            tabName: baseline.pageIdentity.tabName,
            url: baseline.pageIdentity.url,
        },
    };
    trimDiffBaselineMap(map, MAX_DIFF_BASELINE_COUNT);
};

const createSnapshotSessionEntry = (pageIdentity: SnapshotPageIdentity): SnapshotSessionEntry => ({
    pageIdentity,
    overlays: createEmptyOverlays(),
    diffBaselines: {},
    dirty: false,
    version: 1,
});

const createEmptyOverlays = (): SnapshotOverlays => ({
    renamedNodes: {},
    addedEntities: [],
    deletedEntities: [],
});

const resolveSnapshotPageIdentity = (binding: PageBinding): SnapshotPageIdentity => ({
    workspaceName: binding.workspaceName,
    tabName: binding.tabName,
    url: safeReadPageUrl(binding),
});

const syncPageIdentity = (entry: SnapshotSessionEntry, nextIdentity: SnapshotPageIdentity): boolean => {
    if (isSamePageIdentity(entry.pageIdentity, nextIdentity)) {
        return false;
    }

    entry.pageIdentity = nextIdentity;
    entry.baseSnapshot = undefined;
    entry.finalSnapshot = undefined;
    entry.finalEntityView = undefined;
    entry.diffBaselines = {};
    entry.overlays = createEmptyOverlays();
    entry.dirty = true;
    entry.lastDirtyAt = Date.now();
    entry.staleReason = 'page-identity-changed';
    entry.version = (entry.version || 0) + 1;

    snapshotDebugLog('cache-stale', {
        reason: 'page-identity-changed',
        identity: nextIdentity,
    });

    return true;
};

const composeFinalFromBase = (entry: SnapshotSessionEntry) => {
    if (!entry.baseSnapshot) {
        entry.finalSnapshot = undefined;
        entry.finalEntityView = undefined;
        return;
    }

    entry.finalSnapshot = applySnapshotOverlay(entry.baseSnapshot, entry.overlays);
    entry.finalEntityView = buildFinalEntityViewFromSnapshot(entry.finalSnapshot, entry.overlays, true);
};

const ensureComposedSnapshot = (entry: SnapshotSessionEntry): SnapshotResult => {
    if (!entry.baseSnapshot) {
        throw new Error('snapshot base missing while composing final snapshot');
    }
    if (!entry.finalSnapshot || !entry.finalEntityView) {
        composeFinalFromBase(entry);
    }
    if (!entry.finalSnapshot) {
        throw new Error('snapshot final missing after compose');
    }
    return entry.finalSnapshot;
};

const setLatestSnapshotCache = (binding: PageBinding, snapshot: SnapshotResult) => {
    const cache = binding.traceCtx.cache as TraceSnapshotCache;
    cache.latestSnapshot = snapshot;
    cache.latestSnapshotAt = Date.now();
};

const isSnapshotTtlExpired = (entry: SnapshotSessionEntry, ttlMs?: number): boolean => {
    if (!entry.lastRefreshAt) {return true;}
    const ttl = resolveSnapshotTtlMs(ttlMs);
    if (ttl <= 0) {return false;}
    return Date.now() - entry.lastRefreshAt > ttl;
};

const resolveSnapshotTtlMs = (ttlMs?: number): number => {
    if (typeof ttlMs === 'number' && Number.isFinite(ttlMs)) {
        return Math.max(0, Math.floor(ttlMs));
    }

    const envRaw = process.env.RPA_SNAPSHOT_TTL_MS;
    if (envRaw) {
        const envTtl = Number(envRaw);
        if (Number.isFinite(envTtl)) {
            return Math.max(0, Math.floor(envTtl));
        }
    }

    return DEFAULT_SNAPSHOT_TTL_MS;
};

const summarizeOverlays = (overlays: SnapshotOverlays) => ({
    renameCount: Object.keys(overlays.renamedNodes).length,
    addCount: overlays.addedEntities.length,
    deleteCount: overlays.deletedEntities.length,
});

const safeReadPageUrl = (binding: PageBinding): string => {
    try {
        const pageLike = binding.page as { url?: () => string };
        if (typeof pageLike.url === 'function') {
            return normalizeText(pageLike.url()) || '';
        }
        return '';
    } catch {
        return '';
    }
};

const isSamePageIdentity = (left: SnapshotPageIdentity, right: SnapshotPageIdentity): boolean => {
    return (
        left.workspaceName === right.workspaceName &&
        left.tabName === right.tabName &&
        left.url === right.url
    );
};

const ensureDiffBaselineMap = (entry: SnapshotSessionEntry): Record<string, SnapshotDiffBaselineEntry> => {
    if (!entry.diffBaselines || typeof entry.diffBaselines !== 'object') {
        entry.diffBaselines = {};
    }
    return entry.diffBaselines;
};

const trimDiffBaselineMap = (map: Record<string, SnapshotDiffBaselineEntry>, maxCount: number) => {
    const keys = Object.keys(map);
    if (keys.length <= maxCount) {return;}

    const sorted = keys.sort((left, right) => {
        const leftAt = map[left].createdAt || 0;
        const rightAt = map[right].createdAt || 0;
        return leftAt - rightAt;
    });
    const overflow = sorted.length - maxCount;
    for (let index = 0; index < overflow; index += 1) {
        delete map[sorted[index]];
    }
};

const isSnapshotSessionStore = (value: unknown): value is SnapshotSessionStore => {
    if (!value || typeof value !== 'object') {return false;}
    const store = value as SnapshotSessionStore;
    return typeof store.version === 'number' && typeof store.entries === 'object';
};
