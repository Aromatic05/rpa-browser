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

test('table member bindings cannot replace the component root business binding', async () => {
    const fixture = createV2BusinessPage();
    const tableProfile = fixture.capture.entityRules?.profiles['orders-table'];
    assert.ok(tableProfile);
    const rootEntry = Object.entries(tableProfile.semanticBindings.byId)
        .find(([, binding]) => binding.targetKind === 'table-component');
    assert.ok(rootEntry);
    const [rootId, root] = rootEntry;
    const tableId = root.target.componentIds[0];
    assert.ok(tableId);
    const competingMember = {
        ...root,
        id: 'orders-table:000-member',
        ruleId: '000-member',
        planStepId: 'orders-table:000-member',
        targetKind: 'node' as const,
        annotation: {ruleId: '000-member', actionIntent: 'query', actionRole: 'module'},
        target: {
            ...root.target,
            componentIds: [tableId],
            nodeIds: [fixture.nodeIds.submit],
        },
    };
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
                            [rootId]: root,
                            [competingMember.id]: competingMember,
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

    const table = buildPageSessionEntityView(entry).entities.find((entity) => entity.kind === 'table');
    assert.equal(table?.businessTag, 'order.table.main');
    assert.equal(table?.bindingId, root.id);
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


test('table member bindings remain isolated between components in the same profile', () => {
    const active = {rendered: true, subtreeActive: true, hiddenByStyle: false, inert: false, ariaExposed: true};
    const target = (componentIds: string[], nodeIds: string[]) => ({
        componentIds,
        nodeIds,
        fieldIds: [],
        actionIds: [],
        rowIds: [],
        columnIds: [],
    });
    const binding = (
        id: string,
        ruleId: string,
        componentIds: string[],
        nodeIds: string[],
        annotation: Record<string, unknown>,
    ) => ({
        id,
        profileName: 'shared-tables',
        ruleId,
        planStepId: `shared-tables:${ruleId}`,
        domain: 'table' as const,
        targetKind: componentIds.length > 0 && annotation.businessTag ? 'table-component' as const : 'node' as const,
        origin: 'confirmed' as const,
        disposition: 'active' as const,
        status: 'active' as const,
        annotation: {ruleId, ...annotation},
        target: target(componentIds, nodeIds),
    });
    const table = (id: string, nodeId: string) => ({
        id,
        status: 'complete',
        location: {structuralRootNodeId: nodeId},
        columns: [],
        body: {visibleRows: []},
    });
    const entry = {
        capture: {
            control: {
                observation: {
                    nodes: {
                        'orders-root': {tag: 'table'},
                        'returns-root': {tag: 'table'},
                        'orders-search': {tag: 'button'},
                        'returns-search': {tag: 'button'},
                    },
                    attributes: {
                        'orders-root': {id: 'orders'},
                        'returns-root': {id: 'returns'},
                        'orders-search': {},
                        'returns-search': {},
                    },
                    accessibility: {},
                    runtimeState: {},
                    text: {
                        'orders-root': 'Orders',
                        'returns-root': 'Returns',
                        'orders-search': 'Search orders',
                        'returns-search': 'Search returns',
                    },
                    children: {
                        'orders-root': [],
                        'returns-root': [],
                        'orders-search': [],
                        'returns-search': [],
                    },
                    parents: {},
                    documentOrder: {
                        'orders-root': 1,
                        'orders-search': 2,
                        'returns-root': 3,
                        'returns-search': 4,
                    },
                    activity: {
                        'orders-root': active,
                        'returns-root': active,
                        'orders-search': active,
                        'returns-search': active,
                    },
                },
                controls: {byNodeId: {}, controls: {}},
            },
            form: {forms: {forms: {}}},
            table: {
                tables: {
                    tables: {
                        orders: table('orders', 'orders-root'),
                        returns: table('returns', 'returns-root'),
                    },
                    rows: {},
                    cells: {},
                    columns: {},
                },
            },
        },
        semanticBindingsByProfile: {
            'shared-tables': {
                byId: {
                    'shared-tables:orders': binding(
                        'shared-tables:orders',
                        'orders',
                        ['orders'],
                        ['orders-root'],
                        {businessTag: 'orders.table', entityKind: 'table'},
                    ),
                    'shared-tables:returns': binding(
                        'shared-tables:returns',
                        'returns',
                        ['returns'],
                        ['returns-root'],
                        {businessTag: 'returns.table', entityKind: 'table'},
                    ),
                    'shared-tables:orders-search': binding(
                        'shared-tables:orders-search',
                        'orders-search',
                        ['orders'],
                        ['orders-search'],
                        {actionIntent: 'searchOrders', actionText: 'Search orders', actionRole: 'module'},
                    ),
                    'shared-tables:returns-search': binding(
                        'shared-tables:returns-search',
                        'returns-search',
                        ['returns'],
                        ['returns-search'],
                        {actionIntent: 'searchReturns', actionText: 'Search returns', actionRole: 'module'},
                    ),
                },
            },
        },
    } as any;

    const view = buildPageSessionEntityView(entry);
    const orders = view.entities.find((entity) => entity.businessTag === 'orders.table');
    const returns = view.entities.find((entity) => entity.businessTag === 'returns.table');
    assert.deepEqual(orders?.annotation?.moduleActions, [{
        actionIntent: 'searchOrders',
        text: 'Search orders',
        nodeId: 'orders-search',
    }]);
    assert.deepEqual(returns?.annotation?.moduleActions, [{
        actionIntent: 'searchReturns',
        text: 'Search returns',
        nodeId: 'returns-search',
    }]);
});
