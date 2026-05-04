import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../../src/runner/run_steps';
import type { Checkpoint } from '../../../src/runner/checkpoint';
import { executeBrowserCheckpoint } from '../../../src/runner/steps/executors/checkpoint';
import { executeBrowserCompute } from '../../../src/runner/steps/executors/compute';
import { executeBrowserQuery } from '../../../src/runner/steps/executors/query';
import type { SnapshotResult, UnifiedNode } from '../../../src/runner/steps/executors/snapshot/core/types';
import type { StepUnion } from '../../../src/runner/steps/types';

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
    const nextPage = createNode('next_page', 'button', 'Next page');
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

const createDeps = () => {
    const binding = {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        tabName: 'tk-1',
        traceCtx: { cache: {} as Record<string, unknown> },
    };
    return {
        runtime: {
            ensureActivePage: async () => binding,
        } as any,
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.checkpoint': executeBrowserCheckpoint,
                    'browser.query': executeBrowserQuery,
                    'browser.compute': executeBrowserCompute,
                    'browser.snapshot': async (step: StepUnion) => {
                        const snapshot = createTableFixtureSnapshot();
                        binding.traceCtx.cache.latestSnapshot = snapshot;
                        return {
                            stepId: step.id,
                            ok: true,
                            data: snapshot.root,
                        };
                    },
                    'browser.get_page_info': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: { url: 'https://example.test/table' },
                    }),
                    'browser.click': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: { clickedId: (step.args as { id?: unknown }).id },
                    }),
                }) as any,
        } as any,
    };
};

const runWithCheckpoints = async (step: StepUnion, checkpoints: Checkpoint[], deps = createDeps() as any) => {
    const queue = createStepsQueue([step]);
    closeStepsQueue(queue);
    const pipe = createResultPipe();
    const signals = createSignalChannel();
    const checkpoint = await runSteps(
        {
            runId: 'run-1',
            workspaceName: 'ws-1',
            stepsQueue: queue,
            resultPipe: pipe,
            signalChannel: signals,
            checkpoints,
            stopOnError: true,
        },
        deps,
    );
    return {
        checkpoint,
        results: readResultPipe(pipe).items,
    };
};

test('browser.checkpoint executes prepare/content/output with runtime scopes', async () => {
    const step: StepUnion = {
        id: 'cp-step-1',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-procedure',
            input: {
                expectedHost: 'example.test',
            },
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-procedure',
            kind: 'procedure',
            prepare: [{ type: 'wait', args: { ms: 0 } }],
            content: [
                {
                    type: 'act',
                    step: {
                        name: 'browser.get_page_info',
                        args: {},
                    },
                    saveAs: 'pageInfo',
                },
            ],
            output: {
                pageUrl: { ref: 'local.pageInfo.url' },
                expectedHost: { ref: 'input.expectedHost' },
            },
        },
    ];

    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal((results[0].data as any).output.pageUrl, 'https://example.test/table');
    assert.equal((results[0].data as any).output.expectedHost, 'example.test');
});

test('browser.checkpoint fails on missing ref and invalid output path', async () => {
    const step: StepUnion = {
        id: 'cp-step-2',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-invalid',
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-invalid',
            kind: 'procedure',
            content: [],
            output: {
                'bad.path': { ref: 'local.not_found' },
            },
        },
    ];

    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_CHECKPOINT_OUTPUT_PATH_INVALID');
});

test('browser.checkpoint supports query compute act and local/output data flow', async () => {
    const step: StepUnion = {
        id: 'cp-step-3',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-query-compute-act',
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-query-compute-act',
            kind: 'procedure',
            prepare: [{ type: 'wait', args: { ms: 0 } }],
            content: [
                { type: 'snapshot', args: {}, saveAs: 'snapshot' },
                {
                    type: 'query',
                    args: { from: 'snapshot', where: { role: 'row' }, limit: 10 },
                    saveAs: 'rows',
                },
                {
                    type: 'compute',
                    args: {
                        expr: { op: 'len', args: [{ literal: { ref: 'local.rows.nodeIds' } }] },
                    },
                    saveAs: 'rowCount',
                },
                {
                    type: 'query',
                    args: {
                        from: 'snapshot',
                        where: { role: 'button', text: { contains: 'next' } },
                        limit: 1,
                    },
                    saveAs: 'actionTarget',
                },
                {
                    type: 'act',
                    step: {
                        name: 'browser.click',
                        args: {
                            id: { ref: 'local.actionTarget.nodeIds.0' },
                        },
                    },
                    saveAs: 'clickResult',
                },
            ],
            output: {
                rowCount: { ref: 'local.rowCount.value' },
                clickedId: { ref: 'local.clickResult.clickedId' },
            },
        },
    ];

    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal((results[0].data as any).output.rowCount, 2);
    assert.equal((results[0].data as any).output.clickedId, 'next_page');
});

test('browser.checkpoint fails on invalid compute ref in content action', async () => {
    const step: StepUnion = {
        id: 'cp-step-4',
        name: 'browser.checkpoint',
        args: {
            checkpointId: 'cp-compute-ref-invalid',
        },
    } as StepUnion;
    const checkpoints: Checkpoint[] = [
        {
            id: 'cp-compute-ref-invalid',
            kind: 'procedure',
            content: [
                {
                    type: 'compute',
                    args: {
                        expr: {
                            op: 'len',
                            args: [{ literal: { ref: 'local.missing.nodes' } }],
                        },
                    },
                    saveAs: 'count',
                },
            ],
        },
    ];
    const { checkpoint, results } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'failed');
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error?.code, 'ERR_CHECKPOINT_REF_NOT_FOUND');
});
