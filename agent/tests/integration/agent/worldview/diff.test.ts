import test from 'node:test';
import assert from 'node:assert/strict';
import {diffWorldViews} from '../../../../src/agent/worldview/diff';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../src/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

test('WorldView diff reuses Snapshot V2 semantic diff across pinned revisions', async () => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const beforeEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const changedCapture = structuredClone(fixture.capture);
    changedCapture.control.observation.identity.captureRevision = 2;
    (changedCapture.control.observation.text as Record<string, string | undefined>)[fixture.nodeIds.panel] = '已更新面板';
    const afterEntry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => changedCapture,
    });
    const toView = (entry: typeof beforeEntry): WorldView => Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });

    const result = diffWorldViews(toView(beforeEntry), toView(afterEntry));
    assert.equal(result.ok, true);
    if (!result.ok) {throw new Error('expected World diff');}
    assert.equal(result.worldBefore.revision.captureRevision, 1);
    assert.equal(result.worldAfter.revision.captureRevision, 2);
    assert.equal(result.diff.mode, 'diff');
    assert.equal(result.diff.projection.meta.changedNodeCount, 1);
    assert.deepEqual(result.diff.projection.meta.removedNodeKeys, []);
});
