import test from 'node:test';
import assert from 'node:assert/strict';
import {queryPageSessionEntry} from '../../../../src/automation/runner/session/query';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createEntry = async () => {
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return {entry, fixture};
};

test('PageSession query is a pure read over one fixed snapshot entry', async () => {
    const {entry, fixture} = await createEntry();

    const first = queryPageSessionEntry(entry, {
        from: 'snapshot',
        where: {attrs: {'data-row-key': 'SO-001'}},
    });
    const second = queryPageSessionEntry(entry, {
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) {return;}
    assert.deepEqual((first.data as any).nodeIds, [fixture.nodeIds['row-1']]);
    assert.equal((second.data as any).value, 1);
    assert.equal((first.data as any).meta.pageEpoch, entry.identity.pageEpoch);
    assert.equal((first.data as any).meta.captureRevision, entry.identity.captureRevision);
    assert.equal(entry.identity.captureRevision, 1);
});

test('PageSession query failures retain the pinned snapshot identity', async () => {
    const {entry} = await createEntry();
    const result = queryPageSessionEntry(entry, {
        op: 'entity',
        businessTag: 'missing.entity',
        query: 'table.rowCount',
    });

    assert.equal(result.ok, false);
    if (result.ok) {return;}
    assert.equal(result.error.code, 'ERR_NOT_FOUND');
    const details = result.error.details as Record<string, unknown>;
    assert.equal(details.pageEpoch, entry.identity.pageEpoch);
    assert.equal(details.captureRevision, entry.identity.captureRevision);
});
