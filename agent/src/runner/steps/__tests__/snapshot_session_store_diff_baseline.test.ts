import test from 'node:test';
import assert from 'node:assert/strict';
import type { UnifiedNode } from '../executors/snapshot/core/types';
import {
    ensureSnapshotSessionEntry,
    readSnapshotDiffBaseline,
    writeSnapshotDiffBaseline,
} from '../executors/snapshot/core/session_store';
import { buildSnapshotDiffBaselineKey } from '../executors/snapshot/pipeline/scoped_diff';

const createBaselineRoot = (id: string): UnifiedNode => ({
    id,
    role: 'root',
    children: [],
});

const createBinding = (urlRef: { current: string }) => {
    return {
        workspaceId: 'ws-1',
        tabId: 'tab-1',
        tabToken: 'token-1',
        page: {
            url: () => urlRef.current,
        },
        traceTools: {},
        traceCtx: {
            cache: {},
        },
    } as any;
};

test('diff baseline is stored on session entry and keyed by contain/depth/filter', () => {
    const url = { current: 'https://example.test/a' };
    const binding = createBinding(url);
    const entry = ensureSnapshotSessionEntry(binding);
    const store = (binding.traceCtx.cache as { snapshotSessionStore?: { entries?: Record<string, unknown> } }).snapshotSessionStore;
    assert.ok(store?.entries?.['ws-1:token-1']);

    const keyA = buildSnapshotDiffBaselineKey({
        contain: 'root',
        depth: -1,
        filterSignature: '{}',
    });
    const keyB = buildSnapshotDiffBaselineKey({
        contain: 'group-info',
        depth: 1,
        filterSignature: '{"role":["button"]}',
    });

    writeSnapshotDiffBaseline(entry, keyA, {
        snapshotId: 'snap-a',
        root: createBaselineRoot('root'),
        createdAt: 100,
        pageIdentity: entry.pageIdentity,
    });
    writeSnapshotDiffBaseline(entry, keyB, {
        snapshotId: 'snap-b',
        root: createBaselineRoot('group-info'),
        createdAt: 200,
        pageIdentity: entry.pageIdentity,
    });

    const hitA = readSnapshotDiffBaseline(entry, keyA);
    const hitB = readSnapshotDiffBaseline(entry, keyB);
    const miss = readSnapshotDiffBaseline(entry, buildSnapshotDiffBaselineKey({
        contain: 'group-info',
        depth: 2,
        filterSignature: '{"role":["button"]}',
    }));

    assert.equal(hitA?.snapshotId, 'snap-a');
    assert.equal(hitA?.root.id, 'root');
    assert.equal(hitB?.snapshotId, 'snap-b');
    assert.equal(hitB?.root.id, 'group-info');
    assert.equal(miss, undefined);
    assert.ok(entry.diffBaselines && Object.keys(entry.diffBaselines).length >= 2);
});

test('diff baseline is invalidated when page identity changes', () => {
    const url = { current: 'https://example.test/a' };
    const binding = createBinding(url);
    const entry = ensureSnapshotSessionEntry(binding);

    const key = buildSnapshotDiffBaselineKey({
        contain: 'root',
        depth: -1,
        filterSignature: '{}',
    });

    writeSnapshotDiffBaseline(entry, key, {
        snapshotId: 'snap-1',
        root: createBaselineRoot('root'),
        createdAt: 100,
        pageIdentity: entry.pageIdentity,
    });
    assert.equal(readSnapshotDiffBaseline(entry, key)?.snapshotId, 'snap-1');

    url.current = 'https://example.test/b';
    const refreshedEntry = ensureSnapshotSessionEntry(binding);
    const afterNavigation = readSnapshotDiffBaseline(refreshedEntry, key);

    assert.equal(afterNavigation, undefined);
});
