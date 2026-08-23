import test from 'node:test';
import assert from 'node:assert/strict';
import {compileBrowserQuery} from '../../../src/query/compile';
import {queryIrJsonSchema} from '../../../src/query/schema';
import {debugQueryJsonSchema} from '../../../src/agent/debug/tools/schemas';
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

test('debug.query publishes the canonical QueryIR schema instead of browser source syntax', () => {
    assert.equal(debugQueryJsonSchema, queryIrJsonSchema);
    const operations = (queryIrJsonSchema.$defs.query.oneOf as readonly any[])
        .map((variant) => variant.properties.op.const);
    assert.deepEqual(operations, [
        'scan', 'traverse', 'filter', 'limit', 'one', 'exists', 'count', 'entity', 'entity.target',
    ]);
    const serialized = JSON.stringify(queryIrJsonSchema);
    assert.equal(serialized.includes('"from"'), false);
    assert.equal(serialized.includes('snapshot.latest'), false);
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

test('Query IR count, exists and one compose over structural node sets', async () => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const rows = {
        op: 'filter' as const,
        predicate: {active: true as const, attrsEqual: {'data-row-key': 'SO-001'}},
        input: {
            op: 'traverse' as const,
            relation: 'descendant' as const,
            input: {op: 'scan' as const, source: {kind: 'roots' as const}},
        },
    };

    for (const [op, expected] of [['count', 1], ['exists', true]] as const) {
        const result = executePageSessionQueryIR(entry, {op, input: rows});
        assert.equal(result.ok, true);
        if (!result.ok) {throw new Error(`${op} failed`);}
        assert.deepEqual(result.data, {
            kind: 'value',
            value: expected,
            meta: {pageEpoch: 'v2-business', captureRevision: 1},
        });
    }

    const one = executePageSessionQueryIR(entry, {op: 'one', input: rows});
    assert.equal(one.ok, true);
    if (!one.ok) {throw new Error('one failed');}
    assert.equal(one.data.kind, 'nodeId');
    if (one.data.kind !== 'nodeId') {throw new Error('expected nodeId result');}
    assert.equal(typeof one.data.nodeId, 'string');
    assert.equal(one.data.nodeId.length > 0, true);
    assert.deepEqual(one.data.meta, {pageEpoch: 'v2-business', captureRevision: 1});
});

test('Query IR one returns a structured cardinality counterexample', async () => {
    const fixture = createV2BusinessPage();
    const store = new PageSnapshotSessionStore<object>();
    const entry = await store.ensureFresh({
        pageKey: {},
        pageUrl: '/orders',
        capture: async () => fixture.capture,
    });
    const scan = {
        op: 'traverse' as const,
        relation: 'descendant' as const,
        input: {op: 'scan' as const, source: {kind: 'roots' as const}},
    };

    const missing = executePageSessionQueryIR(entry, {
        op: 'one',
        input: {
            op: 'filter',
            predicate: {active: true, attrsEqual: {'data-row-key': 'missing'}},
            input: scan,
        },
    });
    assert.deepEqual(missing, {
        ok: false,
        error: {
            code: 'ERR_NOT_FOUND',
            message: 'one expected exactly one result, got 0',
            details: {
                operator: 'one',
                expected: 1,
                actual: 0,
                pageEpoch: 'v2-business',
                captureRevision: 1,
            },
        },
    });

    const multiple = executePageSessionQueryIR(entry, {
        op: 'one',
        input: {op: 'filter', predicate: {active: true}, input: scan},
    });
    assert.equal(multiple.ok, false);
    if (multiple.ok) {throw new Error('expected ambiguous cardinality');}
    assert.equal(multiple.error.code, 'ERR_AMBIGUOUS');
    assert.equal((multiple.error.details as any).operator, 'one');
    assert.equal((multiple.error.details as any).expected, 1);
    assert.equal((multiple.error.details as any).actual > 1, true);
    assert.equal((multiple.error.details as any).captureRevision, 1);
});
