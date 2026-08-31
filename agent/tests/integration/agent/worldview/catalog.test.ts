import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorldCatalog} from '../../../../src/agent/worldview/catalog';
import type {WorldView} from '../../../../src/agent/worldview/contracts';
import {PageSnapshotSessionStore} from '../../../../src/automation/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createView = async (): Promise<WorldView> => {
    const fixture = createV2BusinessPage();
    const capture = structuredClone(fixture.capture);
    const tableProfile = capture.entityRules?.profiles['orders-table'];
    assert.ok(tableProfile);
    const search = Object.values(tableProfile.semanticBindings.byId)
        .find((binding) => binding.annotation.actionIntent === 'search');
    assert.ok(search);
    search.annotation.effect = {reversibility: 'irreversible'};

    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => capture,
    });
    return Object.freeze({
        workspaceName: 'ws-catalog',
        tabName: 'main',
        pageUrl: '/orders',
        revision: Object.freeze({...entry.identity}),
        entry,
    });
};

test('World Catalog exposes active business schema from one pinned WorldView', async () => {
    const catalog = buildWorldCatalog(await createView());

    assert.deepEqual(catalog.world.revision, {
        pageEpoch: 'v2-business',
        captureRevision: 1,
    });
    assert.deepEqual(catalog.entities.map((entity) => entity.businessTag).sort(), [
        'order.form.main',
        'order.table.main',
    ]);

    const table = catalog.entities.find((entity) => entity.businessTag === 'order.table.main');
    assert.ok(table);
    assert.equal(table.kind, 'table');
    assert.deepEqual(table.profileNames, ['orders-table']);
    assert.deepEqual(table.primaryKey, {fieldKey: 'orderNo'});
    assert.deepEqual(table.fields, [{
        fieldKey: 'orderNo',
        label: '订单编号',
        targetKind: 'table.filter',
        effect: {reversibility: 'unknown'},
    }]);
    assert.deepEqual(table.actions, [{
        actionIntent: 'search',
        label: '查询',
        targetKind: 'table.module_action',
        effect: {reversibility: 'irreversible'},
    }]);
    assert.deepEqual(table.rowActions, [{
        actionIntent: 'approve',
        label: '审核',
        targetKind: 'table.row_action',
        effect: {reversibility: 'unknown'},
    }]);
    assert.deepEqual(table.queries, [
        'table.rowCount',
        'table.headers',
        'table.primaryKey',
        'table.columns',
        'table.currentRows',
        'table.hasNextPage',
    ]);

    const form = catalog.entities.find((entity) => entity.businessTag === 'order.form.main');
    assert.ok(form);
    assert.deepEqual(form.queries, ['form.fields', 'form.actions']);
});

test('World Catalog omits structural entities without a businessTag', async () => {
    const view = await createView();
    const catalog = buildWorldCatalog(view);

    assert.equal(catalog.entities.every((entity) => entity.businessTag.length > 0), true);
    assert.equal(catalog.entities.some((entity) => entity.source === 'structural'), false);
});
