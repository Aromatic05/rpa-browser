import test from 'node:test';
import assert from 'node:assert/strict';
import {compileBrowserQuery} from '../../../src/query/compile';
import {executePageSessionQueryIR} from '../../../src/runner/session/query_ir';
import {PageSnapshotSessionStore} from '../../../src/snapshot';
import {createV2BusinessPage} from '../../helpers/v2_business_page';

test('structural browser.query compiles to scan/traverse/filter/limit IR', () => {
    const compiled = compileBrowserQuery({
        from: {nodes: [{id: 'root-a'}, {handle: {nodeId: 'root-b'}}]},
        relation: 'child',
        where: {
            role: 'button',
            text: {contains: 'Submit'},
            attrs: {'data-kind': 'primary'},
        },
        limit: 7,
    });

    assert.deepEqual(compiled, {
        ok: true,
        ir: {
            op: 'limit',
            count: 7,
            input: {
                op: 'filter',
                predicate: {
                    active: true,
                    roleEquals: 'button',
                    textContains: 'Submit',
                    attrsEqual: {'data-kind': 'primary'},
                },
                input: {
                    op: 'traverse',
                    relation: 'child',
                    input: {
                        op: 'scan',
                        source: {kind: 'nodes', nodeIds: ['root-a', 'root-b']},
                    },
                },
            },
        },
    });
});

test('structural browser.query defaults to snapshot roots, descendant traversal and bounded limit', () => {
    const compiled = compileBrowserQuery({from: 'snapshot.latest'});
    assert.deepEqual(compiled, {
        ok: true,
        ir: {
            op: 'limit',
            count: 500,
            input: {
                op: 'filter',
                predicate: {active: true},
                input: {
                    op: 'traverse',
                    relation: 'descendant',
                    input: {op: 'scan', source: {kind: 'roots'}},
                },
            },
        },
    });
});

test('business query forms compile to canonical entity leaves', () => {
    assert.deepEqual(compileBrowserQuery({
        op: 'entity',
        businessTag: 'orders.table',
        query: 'table.currentRows',
    }), {
        ok: true,
        ir: {
            op: 'entity',
            businessTag: 'orders.table',
            query: 'table.currentRows',
        },
    });

    assert.deepEqual(compileBrowserQuery({
        op: 'entity.target',
        businessTag: 'orders.table',
        target: {
            kind: 'table.row_action',
            primaryKey: {fieldKey: 'orderNo', value: 'SO-42'},
            actionIntent: 'approve',
        },
    }), {
        ok: true,
        ir: {
            op: 'entity.target',
            businessTag: 'orders.table',
            target: {
                kind: 'table.row_action',
                primaryKey: {fieldKey: 'orderNo', value: 'SO-42'},
                actionIntent: 'approve',
            },
        },
    });
});

test('browser query compiler rejects invalid source, relation and limit before execution', () => {
    assert.equal(compileBrowserQuery({from: 'other'} as never).ok, false);
    assert.equal(compileBrowserQuery({from: {nodeIds: []}}).ok, false);
    assert.equal(compileBrowserQuery({from: 'snapshot', relation: 'parent'} as never).ok, false);
    assert.equal(compileBrowserQuery({from: 'snapshot', limit: 0}).ok, false);
});

test('canonical Query IR executes directly over one PageSession entry', async () => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const structural = compileBrowserQuery({
        from: 'snapshot',
        where: {attrs: {'data-row-key': 'SO-001'}},
        limit: 1,
    });
    assert.equal(structural.ok, true);
    if (!structural.ok) {throw new Error('structural query failed to compile');}
    const structuralResult = executePageSessionQueryIR(entry, structural.ir);
    assert.equal(structuralResult.ok, true);
    if (!structuralResult.ok) {throw new Error('structural IR failed to execute');}
    assert.equal(structuralResult.data.kind, 'nodeIds');
    if (structuralResult.data.kind !== 'nodeIds') {throw new Error('expected nodeIds result');}
    assert.equal(structuralResult.data.count, 1);
    assert.equal(structuralResult.data.meta?.captureRevision, 1);

    const business = compileBrowserQuery({
        op: 'entity',
        businessTag: 'order.table.main',
        query: 'table.rowCount',
    });
    assert.equal(business.ok, true);
    if (!business.ok) {throw new Error('business query failed to compile');}
    const businessResult = executePageSessionQueryIR(entry, business.ir);
    assert.equal(businessResult.ok, true);
    if (!businessResult.ok) {throw new Error('business IR failed to execute');}
    assert.deepEqual(businessResult.data, {
        kind: 'value',
        value: 1,
        meta: {
            businessTag: 'order.table.main',
            entityId: businessResult.data.meta?.entityId,
            entityKind: 'table',
            componentId: businessResult.data.meta?.componentId,
        },
    });
});
