import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugTransaction} from '../../../../../src/agent/debug/transaction/state';
import type {WorldView} from '../../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../../helpers/v2_business_page';

const createViews = async (): Promise<[WorldView, WorldView]> => {
    const store = new PageSnapshotSessionStore<object>();
    const pageKey = {};
    const fixture = createV2BusinessPage();
    const first = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const secondCapture = structuredClone(fixture.capture);
    secondCapture.control.observation.identity.captureRevision = 2;
    const second = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        reason: 'explicit',
        capture: async () => secondCapture,
    });
    const toView = (entry: typeof first): WorldView => Object.freeze({
        workspaceName: 'ws-transaction',
        tabName: 'main',
        pageUrl: entry.pageUrl,
        revision: Object.freeze({...entry.identity}),
        entry,
    });
    return [toView(first), toView(second)];
};

test('debug transaction keeps an immutable baseline and effect-indexed savepoints', async () => {
    const [first, second] = await createViews();
    const transaction = createDebugTransaction(first);

    const savepoint = transaction.savepoint(second, 3, 'after-login');
    const snapshot = transaction.snapshot(second, 5);

    assert.equal(typeof snapshot.id, 'string');
    assert.ok(snapshot.id.length > 0);
    assert.deepEqual(snapshot.baseline.revision, first.revision);
    assert.deepEqual(snapshot.current.revision, second.revision);
    assert.equal(snapshot.effectCount, 5);
    assert.deepEqual(snapshot.savepoints, [savepoint]);
    assert.deepEqual(savepoint, {
        id: savepoint.id,
        name: 'after-login',
        effectSequence: 3,
        world: {
            workspaceName: 'ws-transaction',
            tabName: 'main',
            pageUrl: '/orders',
            revision: second.revision,
        },
    });
    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot.savepoints), true);
});

test('debug transaction rejects invalid savepoint effect positions', async () => {
    const [view] = await createViews();
    const transaction = createDebugTransaction(view);

    assert.throws(() => transaction.savepoint(view, -1), /effect sequence/i);
    assert.throws(() => transaction.savepoint(view, 1.5), /effect sequence/i);
    assert.throws(() => transaction.savepoint(view, 0, '   '), /savepoint name/i);
});

test('internal execution savepoints stay hidden until explicitly promoted', async () => {
    const [view] = await createViews();
    const transaction = createDebugTransaction(view);

    const internal = transaction.internalSavepoint(view, 0);
    assert.deepEqual(transaction.snapshot(view, 0).savepoints, []);
    assert.equal(transaction.readSavepoint(internal.id)?.savepoint.id, internal.id);

    const promoted = transaction.promoteSavepoint(internal.id, 'before-statement');
    assert.equal(promoted.id, internal.id);
    assert.equal(promoted.name, 'before-statement');
    assert.deepEqual(transaction.snapshot(view, 0).savepoints, [promoted]);
});
