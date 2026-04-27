import test from 'node:test';
import assert from 'node:assert/strict';
import type { RunStepsDeps } from '../../../src/runner/run_steps';
import type { SnapshotResult, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import { executeBrowserQuery } from '../../../src/runner/steps/executors/query';
import type { Step } from '../../../src/runner/steps/types';

const createNode = (id: string, role: string, name?: string): UnifiedNode => ({
    id,
    role,
    name,
    children: [],
});

const createSnapshot = (): SnapshotResult => {
    const root = createNode('root', 'root');
    const table = createNode('table_1', 'table');
    const row1 = createNode('row_1', 'row', 'Alpha');
    const row2 = createNode('row_2', 'row', 'Beta');
    const nextBtn = createNode('btn_next', 'button', 'Next page');
    root.children.push(table, nextBtn);
    table.children.push(row1, row2);

    return {
        root,
        nodeIndex: {
            root,
            table_1: table,
            row_1: row1,
            row_2: row2,
            btn_next: nextBtn,
        },
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {
            table_1: { tag: 'table' },
            row_1: { tag: 'tr', 'data-row': '1' },
            row_2: { tag: 'tr', 'data-row': '2' },
            btn_next: { tag: 'button', disabled: 'false' },
        },
        contentStore: {},
    };
};

const createDeps = (snapshot: SnapshotResult): RunStepsDeps => ({
    runtime: {
        ensureActivePage: async () => ({
            traceCtx: {
                cache: {
                    latestSnapshot: snapshot,
                },
            },
        }),
    } as any,
    config: {} as any,
    pluginHost: {} as any,
});

test('browser.query can find rows from snapshot descendants', async () => {
    const step: Step<'browser.query'> = {
        id: 'q1',
        name: 'browser.query',
        args: {
            from: 'snapshot',
            where: {
                role: 'row',
                tag: 'tr',
            },
        },
    };
    const result = await executeBrowserQuery(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any).kind, 'nodeIds');
    assert.equal((result.data as any).count, 2);
    assert.deepEqual(
        (result.data as any).nodeIds,
        ['row_1', 'row_2'],
    );
    assert.equal(Array.isArray((result.data as any).meta?.nodes), true);
});

test('browser.query supports from.nodeIds with child relation', async () => {
    const step: Step<'browser.query'> = {
        id: 'q2',
        name: 'browser.query',
        args: {
            from: { nodeIds: ['table_1'] },
            relation: 'child',
            where: {
                text: {
                    contains: 'alp',
                },
            },
        },
    };
    const result = await executeBrowserQuery(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, true);
    assert.equal((result.data as any).kind, 'nodeIds');
    assert.equal((result.data as any).count, 1);
    assert.equal((result.data as any).nodeIds[0], 'row_1');
});

test('browser.query returns ERR_BAD_ARGS on invalid relation', async () => {
    const step = {
        id: 'q3',
        name: 'browser.query',
        args: {
            from: 'snapshot',
            relation: 'invalid',
        },
    } as unknown as Step<'browser.query'>;
    const result = await executeBrowserQuery(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});

test('browser.query returns ERR_BAD_ARGS on unsupported from', async () => {
    const step = {
        id: 'q4',
        name: 'browser.query',
        args: {
            from: 'x',
        },
    } as unknown as Step<'browser.query'>;
    const result = await executeBrowserQuery(step, createDeps(createSnapshot()), 'ws-1');
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
});
