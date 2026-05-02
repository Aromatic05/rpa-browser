import test from 'node:test';
import assert from 'node:assert/strict';
import type { UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import {
    ensureFreshSnapshot,
    ensureSnapshotSessionEntry,
    markSnapshotSessionDirty,
    readSnapshotDiffBaseline,
    shouldMarkSnapshotDirtyByStep,
    writeSnapshotDiffBaseline,
} from '../../../src/runner/steps/executors/snapshot/core/session_store';
import { buildSnapshotDiffBaselineKey } from '../../../src/runner/steps/executors/snapshot/pipeline/scoped_diff';
import { buildSnapshotFromViewRoot } from '../../../src/runner/steps/executors/snapshot/pipeline/scoped_diff';

const createBaselineRoot = (id: string): UnifiedNode => ({
    id,
    role: 'root',
    children: [],
});

const createSnapshot = (id: string) => buildSnapshotFromViewRoot(createBaselineRoot(id), undefined);

const createBinding = (urlRef: { current: string }) => {
    return {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
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
    assert.ok(store?.entries?.['ws-1:tab-1']);

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

test('dirty interaction forces snapshot refresh instead of stale cache reuse', async () => {
    const url = { current: 'https://example.test/a' };
    const binding = createBinding(url);
    let collectCount = 0;

    const collectBaseSnapshot = async () => {
        collectCount += 1;
        return createSnapshot(`root-${collectCount}`);
    };

    const first = await ensureFreshSnapshot(binding, {
        collectBaseSnapshot,
    });
    assert.equal(first.refreshed, true);
    assert.equal(first.snapshot.root.id, 'root-1');

    const second = await ensureFreshSnapshot(binding, {
        collectBaseSnapshot,
    });
    assert.equal(second.refreshed, false);
    assert.equal(second.snapshot.root.id, 'root-1');
    assert.equal(collectCount, 1);

    markSnapshotSessionDirty(binding, 'step:browser.click');

    const third = await ensureFreshSnapshot(binding, {
        collectBaseSnapshot,
    });
    assert.equal(third.refreshed, true);
    assert.equal(third.snapshot.root.id, 'root-2');
    assert.equal(collectCount, 2);
});

test('dirty step policy skips high-frequency read operations and requires explicit evaluate mutation flag', () => {
    assert.equal(shouldMarkSnapshotDirtyByStep('browser.hover', {}), false);
    assert.equal(shouldMarkSnapshotDirtyByStep('browser.scroll', {}), false);
    assert.equal(shouldMarkSnapshotDirtyByStep('browser.mouse', { action: 'move' }), false);

    assert.equal(shouldMarkSnapshotDirtyByStep('browser.evaluate', { expression: '1+1' }), false);
    assert.equal(shouldMarkSnapshotDirtyByStep('browser.evaluate', { expression: 'x=1', mutatesPage: true }), true);

    assert.equal(shouldMarkSnapshotDirtyByStep('browser.click', {}), true);
    assert.equal(shouldMarkSnapshotDirtyByStep('browser.fill', {}), true);
});
