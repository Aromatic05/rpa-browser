import test from 'node:test';
import assert from 'node:assert/strict';
import {createDebugValueProvenanceStore} from '../../../../../src/agent/debug/provenance/store';
import {recomputeDebugValue} from '../../../../../src/agent/debug/provenance/recompute';
import type {DebugQuerySession} from '../../../../../src/agent/debug/query/contracts';
import type {DslValueProvenanceEvent} from '../../../../../src/program/dsl/debug/contracts';

const world = Object.freeze({
    workspaceName: 'ws-provenance',
    tabName: 'main',
    pageUrl: '/orders',
    revision: Object.freeze({pageEpoch: 'epoch-1', captureRevision: 2}),
});

const location = Object.freeze({
    programId: 'main',
    path: 'body.0',
    kind: 'let' as const,
    loops: Object.freeze([]),
    callStack: Object.freeze([]),
});

const record = (
    target: string,
    source: DslValueProvenanceEvent['source'],
): DslValueProvenanceEvent => Object.freeze({target, location, source});

test('query recompute rebuilds dependent QueryIR from recomputed dependency candidates', () => {
    const store = createDebugValueProvenanceStore();
    store.record(record('vars.key', {
        kind: 'query',
        expression: {kind: 'query', op: 'entity', businessTag: 'key.source', payload: 'table.primaryKey'},
        query: {op: 'entity', businessTag: 'key.source', query: 'table.primaryKey'},
        stepId: 'query-key',
        dependencies: Object.freeze([]),
    }));
    store.record(record('vars.target', {
        kind: 'query',
        expression: {
            kind: 'query',
            op: 'entity.target',
            businessTag: 'order.table.main',
            payload: {
                kind: 'table.row',
                primaryKey: {fieldKey: 'orderNo', value: {kind: 'ref', ref: 'vars.key'}},
            },
        },
        query: {
            op: 'entity.target',
            businessTag: 'order.table.main',
            target: {kind: 'table.row', primaryKey: {fieldKey: 'orderNo', value: 'SO-1'}},
        },
        stepId: 'query-target',
        dependencies: Object.freeze(['vars.key']),
    }));

    const queries: unknown[] = [];
    const debug: DebugQuerySession = {
        world,
        query: (ir) => {
            queries.push(ir);
            if (ir.op === 'entity') {
                return {ok: true, world, result: {kind: 'value', value: 'SO-2'}};
            }
            assert.equal(ir.op, 'entity.target');
            if (ir.op !== 'entity.target') {throw new Error('expected target query');}
            assert.deepEqual(ir.target, {
                kind: 'table.row',
                primaryKey: {fieldKey: 'orderNo', value: 'SO-2'},
            });
            return {ok: true, world, result: {kind: 'nodeId', nodeId: 'row-so-2'}};
        },
        compute: () => ({ok: true, world, value: undefined}),
    };

    const result = recomputeDebugValue(store, 'main', 'vars.target', {
        input: {},
        vars: {key: 'SO-1', target: {nodeId: 'row-so-1'}},
        output: {},
    }, debug);

    assert.equal(result.status, 'recomputed');
    if (result.status !== 'recomputed') {throw new Error('expected recomputed');}
    assert.deepEqual(result.candidateValue, {nodeId: 'row-so-2'});
    assert.equal(result.changed, true);
    assert.equal(queries.length, 2);
});

test('query recompute preserves structured QueryIR failure', () => {
    const store = createDebugValueProvenanceStore();
    store.record(record('vars.value', {
        kind: 'query',
        expression: {kind: 'query', op: 'entity', businessTag: 'missing', payload: 'table.rowCount'},
        query: {op: 'entity', businessTag: 'missing', query: 'table.rowCount'},
        stepId: 'query-missing',
        dependencies: Object.freeze([]),
    }));
    const debug: DebugQuerySession = {
        world,
        query: () => ({
            ok: false,
            world,
            error: {code: 'ERR_NOT_FOUND', message: 'missing entity', details: {businessTag: 'missing'}},
        }),
        compute: () => ({ok: true, world, value: undefined}),
    };

    const result = recomputeDebugValue(store, 'main', 'vars.value', {
        input: {}, vars: {value: 1}, output: {},
    }, debug);
    assert.equal(result.status, 'failed');
    if (result.status !== 'failed') {throw new Error('expected failed');}
    assert.deepEqual(result.error, {
        code: 'ERR_NOT_FOUND',
        message: 'missing entity',
        details: {businessTag: 'missing'},
    });
});

test('checkpoint-derived values are explicitly unavailable for pure recompute', () => {
    const store = createDebugValueProvenanceStore();
    store.record(record('vars.session', Object.freeze({
        kind: 'checkpoint' as const,
        checkpointId: 'ensure-login',
        dependencies: Object.freeze([]),
    })));
    const debug: DebugQuerySession = {
        world,
        query: () => ({ok: true, world, result: {kind: 'value', value: null}}),
        compute: () => ({ok: true, world, value: undefined}),
    };

    const result = recomputeDebugValue(store, 'main', 'vars.session', {
        input: {}, vars: {session: {user: 'alice'}}, output: {},
    }, debug);
    assert.equal(result.status, 'unavailable');
    if (result.status !== 'unavailable') {throw new Error('expected unavailable');}
    assert.equal(result.reason, 'unsupported_source');
    assert.equal(result.sourceKind, 'checkpoint');
});

test('compute recompute consumes changed query candidates instead of current scope values', () => {
    const store = createDebugValueProvenanceStore();
    store.record(record('vars.rows', {
        kind: 'query',
        expression: {kind: 'query', op: 'entity', businessTag: 'orders', payload: 'table.currentRows'},
        query: {op: 'entity', businessTag: 'orders', query: 'table.currentRows'},
        stepId: 'query-rows',
        dependencies: Object.freeze([]),
    }));
    store.record(record('vars.count', {
        kind: 'compute',
        expression: {kind: 'compute', expr: {op: 'len', args: [{ref: {path: 'vars.rows'}}]}},
        dependencies: Object.freeze(['vars.rows']),
    }));
    const debug: DebugQuerySession = {
        world,
        query: () => ({ok: true, world, result: {kind: 'value', value: ['SO-1', 'SO-2']}}),
        compute: () => ({ok: true, world, value: undefined}),
    };

    const result = recomputeDebugValue(store, 'main', 'vars.count', {
        input: {}, vars: {rows: ['SO-1'], count: 1}, output: {},
    }, debug);
    assert.equal(result.status, 'recomputed');
    if (result.status !== 'recomputed') {throw new Error('expected recomputed');}
    assert.equal(result.currentValue, 1);
    assert.equal(result.candidateValue, 2);
    assert.equal(result.changed, true);
});

test('non-canonical query provenance remains unavailable for pure recompute', () => {
    const store = createDebugValueProvenanceStore();
    store.record(record('vars.custom', {
        kind: 'query',
        expression: {kind: 'query', op: 'entity', businessTag: 'secret.value', payload: 'current'},
        stepId: 'custom-query',
        dependencies: Object.freeze([]),
    }));
    const debug: DebugQuerySession = {
        world,
        query: () => {throw new Error('non-canonical query must not execute in debugger');},
        compute: () => ({ok: true, world, value: undefined}),
    };

    const result = recomputeDebugValue(store, 'main', 'vars.custom', {
        input: {}, vars: {custom: 'secret'}, output: {},
    }, debug);
    assert.equal(result.status, 'unavailable');
    if (result.status !== 'unavailable') {throw new Error('expected unavailable');}
    assert.equal(result.reason, 'unsupported_query');
    assert.equal(result.sourceKind, 'query');
});
