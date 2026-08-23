import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugQuerySession} from '../../../../../src/agent/debug/query/session';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createView = async (): Promise<WorldView> => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return Object.freeze({
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('DebugQuerySession composes repeated query and compute reads on one WorldView', async () => {
    const session = createDebugQuerySession(await createView());
    const rows = session.query({
        from: 'snapshot',
        where: {attrs: {'data-row-key': 'SO-001'}},
    });
    assert.equal(rows.ok, true);
    if (!rows.ok || rows.result.kind !== 'nodeIds') {return;}

    const count = session.compute({
        op: 'len',
        args: [{ref: {path: 'local.rows'}}],
    }, {local: {rows: rows.result.nodeIds}});

    assert.equal(count.ok, true);
    if (!count.ok) {return;}
    assert.equal(count.value, 1);
    assert.deepEqual(rows.world.revision, {pageEpoch: 'v2-business', captureRevision: 1});
    assert.deepEqual(count.world.revision, rows.world.revision);
});

test('DebugQuerySession reports failures without changing its pinned WorldView', async () => {
    const session = createDebugQuerySession(await createView());
    const failed = session.compute({
        op: 'exists',
        args: [{ref: {path: 'local.missing'}}],
    }, {local: {}});
    const after = session.query({
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });

    assert.equal(failed.ok, false);
    assert.match(failed.ok ? '' : failed.error.message, /missing compute ref/);
    assert.equal(after.ok, true);
    assert.deepEqual(failed.world.revision, after.world.revision);
});
