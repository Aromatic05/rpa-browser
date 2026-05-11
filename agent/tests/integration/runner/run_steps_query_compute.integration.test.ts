import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../src/runner/run_steps';
import type { RunStepsDeps } from '../../src/runner/run_steps';
import { executeBrowserCompute } from '../../src/runner/steps/executors/compute';
import { executeBrowserQuery } from '../../src/runner/steps/executors/query';
import type { SnapshotResult, UnifiedNode } from '../../src/runner/steps/executors/snapshot/core/types';
import type { StepUnion } from '../../src/runner/steps/types';

const createNode = (id: string, role: string, name?: string): UnifiedNode => ({
    id,
    role,
    name,
    children: [],
});

const createTableFixtureSnapshot = (): SnapshotResult => {
    const root = createNode('root', 'root');
    const table = createNode('table_1', 'table');
    const row1 = createNode('row_1', 'row', 'Row A');
    const row2 = createNode('row_2', 'row', 'Row B');
    const nextPage = createNode('next_page', 'button', 'Next');
    root.children.push(table, nextPage);
    table.children.push(row1, row2);

    return {
        root,
        nodeIndex: {
            root,
            table_1: table,
            row_1: row1,
            row_2: row2,
            next_page: nextPage,
        },
        entityIndex: { entities: {}, byNodeId: {} },
        locatorIndex: {},
        bboxIndex: {},
        attrIndex: {
            table_1: { tag: 'table' },
            row_1: { tag: 'tr' },
            row_2: { tag: 'tr' },
            next_page: { tag: 'button' },
        },
        contentStore: {},
    };
};

const createDeps = (snapshot: SnapshotResult): RunStepsDeps => ({
    runtime: (() => {
        const binding = {
            workspaceName: 'ws-1',
            tabName: 'tab-1',
            tabName: 'tk-1',
            traceCtx: {
                cache: {
                    latestSnapshot: snapshot,
                },
            },
        };
        return {
            ensureActivePage: async () => binding,
        };
    })() as any,
    config: {} as any,
    pluginHost: {
        getExecutors: () =>
            ({
                'browser.query': executeBrowserQuery,
                'browser.compute': executeBrowserCompute,
            }) as any,
    } as any,
});

const runWithSteps = async (steps: StepUnion[]) => {
    const queue = createStepsQueue(steps);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps({
        runId: 'run-1',
        workspaceName: 'ws-1',
        stepsQueue: queue,
        resultPipe: pipe,
        signalChannel: signals,
        stopOnError: true,
    } as any,
    createDeps(createTableFixtureSnapshot()));
    return { checkpoint, results: readResultPipe(pipe).items };
};

test('runSteps can consume query rows in compute(len)', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'q_rows',
            name: 'browser.query',
            args: {
                from: 'snapshot',
                where: {
                    role: 'row',
                },
            },
        } as StepUnion,
        {
            id: 'c_len',
            name: 'browser.compute',
            args: {
                expr: {
                    op: 'len',
                    args: [{ ref: { path: 'steps.q_rows.data.nodeIds' } }],
                },
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal((results[1].data as any).value, 2);
});

test('runSteps supports query next button and compute(exists)', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'q_next',
            name: 'browser.query',
            args: {
                from: 'snapshot',
                where: {
                    role: 'button',
                    text: { contains: 'next' },
                },
                limit: 1,
            },
        } as StepUnion,
        {
            id: 'c_exists',
            name: 'browser.compute',
            args: {
                expr: {
                    op: 'exists',
                    args: [{ ref: { path: 'steps.q_next.data.nodeIds' } }],
                },
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[1].ok, true);
    assert.equal((results[1].data as any).value, true);
});

test('runSteps returns stable failure for invalid compute op', async () => {
    const { checkpoint, results } = await runWithSteps([
        {
            id: 'c_bad',
            name: 'browser.compute',
            args: {
                expr: {
                    op: 'bad',
                    args: [],
                },
            },
        } as unknown as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'failed');
    assert.equal(results.length, 1);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_BAD_ARGS');
});
