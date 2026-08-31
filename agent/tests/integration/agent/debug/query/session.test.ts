import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugQuerySession} from '../../../../../src/agent/debug/query/session';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
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
        op: 'filter',
        predicate: {active: true, attrsEqual: {'data-row-key': 'SO-001'}},
        input: {
            op: 'traverse',
            relation: 'descendant',
            input: {op: 'scan', source: {kind: 'roots'}},
        },
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

test('DebugQuerySession preserves one cardinality counterexamples on the pinned World', async () => {
    const session = createDebugQuerySession(await createView());
    const result = session.query({
        op: 'one',
        input: {
            op: 'filter',
            predicate: {active: true, attrsEqual: {'data-row-key': 'missing'}},
            input: {
                op: 'traverse',
                relation: 'descendant',
                input: {op: 'scan', source: {kind: 'roots'}},
            },
        },
    });

    assert.equal(result.ok, false);
    if (result.ok) {throw new Error('expected cardinality failure');}
    assert.equal(result.error.code, 'ERR_NOT_FOUND');
    assert.deepEqual(result.error.details, {
        operator: 'one',
        expected: 1,
        actual: 0,
        pageEpoch: 'v2-business',
        captureRevision: 1,
    });
    assert.deepEqual(result.world.revision, {pageEpoch: 'v2-business', captureRevision: 1});
});
