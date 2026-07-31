import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPageSessionEntityView,
    queryPageSessionBusinessEntity,
    resolvePageSessionBusinessTarget,
} from '../../../../src/runner/session/entity_view';
import {PageSnapshotSessionStore} from '../../../../src/snapshot';
import {createV2BusinessPage} from '../../../helpers/v2_business_page';

const createEntry = async () => {
    const pageKey = {};
    const store = new PageSnapshotSessionStore<object>();
    const fixture = createV2BusinessPage();
    const entry = await store.ensureFresh({
        pageKey,
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    return {entry, fixture};
};

test('V2 entity view combines canonical form/table components with active business bindings', async () => {
    const {entry} = await createEntry();
    const view = buildPageSessionEntityView(entry);
    assert.equal(view.entities.length, 2);
    assert.deepEqual(view.entities.map((entity) => entity.businessTag).sort(), [
        'order.form.main',
        'order.table.main',
    ]);
    assert.equal(view.entities.find((entity) => entity.kind === 'table')?.source, 'confirmed');
});

test('V2 business query reads canonical table rows and annotation metadata', async () => {
    const {entry} = await createEntry();
    const rowCount = queryPageSessionBusinessEntity(entry, 'order.table.main', 'table.rowCount');
    assert.equal(rowCount.ok, true);
    assert.equal(rowCount.data.value, 1);
    assert.equal(rowCount.data.meta.businessTag, 'order.table.main');

    const primaryKey = queryPageSessionBusinessEntity(entry, 'order.table.main', 'table.primaryKey');
    assert.equal(primaryKey.ok, true);
    assert.deepEqual(primaryKey.data.value, {fieldKey: 'orderNo', columns: ['订单编号'], source: 'annotation'});
});

test('V2 business target resolves a row action from primary key and action intent', async () => {
    const {entry, fixture} = await createEntry();
    const resolved = resolvePageSessionBusinessTarget(entry, 'order.table.main', {
        kind: 'table.row_action',
        primaryKey: {fieldKey: 'orderNo', value: 'SO-001'},
        actionIntent: 'approve',
    });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.data.nodeId, fixture.nodeIds.approve);
    assert.equal(resolved.data.meta.targetKind, 'table.row_action');
});

test('V2 row action does not fall back to a same-text control outside the semantic template', async () => {
    const fixture = createV2BusinessPage({rowCount: 2});
    const tableProfile = fixture.capture.entityRules?.profiles['orders-table'];
    assert.ok(tableProfile);
    const rowBindingEntry = Object.entries(tableProfile.semanticBindings.byId)
        .find(([, binding]) => binding.annotation.actionRole === 'row');
    assert.ok(rowBindingEntry);
    const [rowBindingId, rowBinding] = rowBindingEntry;
    const capture = {
        ...fixture.capture,
        entityRules: {
            ...fixture.capture.entityRules!,
            profiles: {
                ...fixture.capture.entityRules!.profiles,
                'orders-table': {
                    ...tableProfile,
                    semanticBindings: {
                        ...tableProfile.semanticBindings,
                        byId: {
                            ...tableProfile.semanticBindings.byId,
                            [rowBindingId]: {
                                ...rowBinding,
                                target: {
                                    ...rowBinding.target,
                                    nodeIds: [fixture.nodeIds['approve-2']],
                                },
                            },
                        },
                    },
                },
            },
        },
    };
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => capture,
    });

    const resolved = resolvePageSessionBusinessTarget(entry, 'order.table.main', {
        kind: 'table.row_action',
        primaryKey: {fieldKey: 'orderNo', value: 'SO-001'},
        actionIntent: 'approve',
    });
    assert.equal(resolved.ok, false);
    if (!resolved.ok) {
        assert.match(resolved.error.message, /has no instance in the row/u);
    }
});

test('V2 form target exposes canonical select-option control kind for DSL actions', async () => {
    const fixture = createV2BusinessPage();
    const buyerNodeId = fixture.nodeIds.buyer;
    const controlId = fixture.capture.control.controls.byNodeId[buyerNodeId]?.[0];
    assert.ok(controlId);
    const control = fixture.capture.control.controls.controls[controlId];
    const customSelectControl: typeof control = {
        ...control,
        kind: 'custom_select',
        capabilities: ['click', 'focus', 'open_popup', 'select_option'],
    };
    const capture = {
        ...fixture.capture,
        control: {
            ...fixture.capture.control,
            controls: {
                ...fixture.capture.control.controls,
                controls: {
                    ...fixture.capture.control.controls.controls,
                    [controlId]: customSelectControl,
                },
            },
        },
    };
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => capture,
    });
    const resolved = resolvePageSessionBusinessTarget(entry, 'order.form.main', {
        kind: 'form.field',
        fieldKey: 'orderNo',
    });
    assert.equal(resolved.ok, true);
    if (!resolved.ok) {return;}
    assert.equal(resolved.data.meta.controlKind, 'custom_select');
});


test('V2 table entity resolves associated filter fields and module actions', async () => {
    const {entry, fixture} = await createEntry();
    const filter = resolvePageSessionBusinessTarget(entry, 'order.table.main', {
        kind: 'table.filter',
        fieldKey: 'orderNo',
    });
    assert.equal(filter.ok, true);
    if (!filter.ok) {return;}
    assert.equal(filter.data.nodeId, fixture.nodeIds.buyer);
    assert.equal(filter.data.meta.targetKind, 'table.filter');

    const search = resolvePageSessionBusinessTarget(entry, 'order.table.main', {
        kind: 'table.module_action',
        actionIntent: 'search',
    });
    assert.equal(search.ok, true);
    if (!search.ok) {return;}
    assert.equal(search.data.nodeId, fixture.nodeIds.submit);
    assert.equal(search.data.meta.targetKind, 'table.module_action');
});
