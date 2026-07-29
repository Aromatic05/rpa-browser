import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../../../src/runner/run_steps';
import type { Checkpoint } from '../../../../src/runner/checkpoint';
import type { CheckpointAction } from '../../../../src/runner/checkpoint/types';
import { executeBrowserCheckpoint } from '../../../../src/runner/steps/executors/checkpoint';
import { executeBrowserCompute } from '../../../../src/runner/steps/executors/compute';
import { executeBrowserQuery } from '../../../../src/runner/steps/executors/query';
import type { StepUnion } from '../../../../src/runner/steps/types';
import {
    buildControlSnapshot,
    buildFormSnapshot,
    buildLocatorIndex,
    buildPageObservation,
    buildRelationIndex,
    buildTableSnapshot,
    type PageSnapshotCapture,
    type RawCapturedNode,
    type RawPageCapture,
} from '../../../../src/snapshot';
import { completeRunStepsDeps } from '../../../helpers/run_steps_workspace';

const active = () => ({hiddenByStyle: false, inert: false, selfHasBox: true, rendered: true});

const rawNode = (
    captureId: string,
    tag: string,
    parentCaptureId: string | undefined,
    childCaptureIds: string[],
    attributes: Record<string, string> = {},
    ownText?: string,
): RawCapturedNode => ({
    captureId,
    scopeId: 'main',
    parentCaptureId,
    childCaptureIds,
    tag,
    attributes,
    ownText,
    backendNodeId: captureId,
    activity: active(),
});

const createTableFixtureCapture = (): {capture: PageSnapshotCapture; nodeIds: Record<string, string>} => {
    const completeness = {dom: 'complete', a11y: 'complete', runtime: 'complete', geometry: 'complete'} as const;
    const raw: RawPageCapture = {
        identity: {pageEpoch: 'checkpoint-table', captureRevision: 1},
        metadata: {schemaVersion: 1, source: 'fixed-fixture', capturedAt: '2026-07-29T00:00:00.000Z'},
        completeness,
        scopes: [{id: 'main', kind: 'document', rootCaptureId: 'html', status: 'captured', completeness}],
        nodes: [
            rawNode('html', 'html', undefined, ['body']),
            rawNode('body', 'body', 'html', ['table', 'next_page']),
            rawNode('table', 'table', 'body', ['tbody'], {id: 'Table'}),
            rawNode('tbody', 'tbody', 'table', ['row_1', 'row_2']),
            rawNode('row_1', 'tr', 'tbody', ['cell_1'], {role: 'row'}),
            rawNode('cell_1', 'td', 'row_1', [], {}, 'Row A'),
            rawNode('row_2', 'tr', 'tbody', ['cell_2'], {role: 'row'}),
            rawNode('cell_2', 'td', 'row_2', [], {}, 'Row B'),
            rawNode('next_page', 'button', 'body', [], {id: 'NextPage'}, 'Next page'),
        ],
        accessibility: [],
        runtimeState: {},
        diagnostics: [],
    };
    const observation = buildPageObservation(raw);
    const relations = buildRelationIndex(observation);
    const locators = buildLocatorIndex(observation);
    const control = buildControlSnapshot({observation, relations, locators});
    return {
        capture: {
            control,
            form: buildFormSnapshot({observation, relations, locators, controls: control.controls}),
            table: buildTableSnapshot({observation, relations, locators, controls: control.controls}),
        },
        nodeIds: Object.fromEntries(Object.entries(observation.captureIdToNodeId)),
    };
};

const createDeps = async () => {
    const workspaceName = 'ws-1';
    const tabName = 'tk-1';
    const url = 'https://example.test/table';
    const page = {url: () => url};
    const {capture, nodeIds} = createTableFixtureCapture();
    const deps = completeRunStepsDeps({
        config: {} as any,
        pluginHost: {
            getExecutors: () =>
                ({
                    'browser.checkpoint': executeBrowserCheckpoint,
                    'browser.query': executeBrowserQuery,
                    'browser.compute': executeBrowserCompute,
                    'browser.snapshot': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: {
                            pageEpoch: capture.control.observation.identity.pageEpoch,
                            captureRevision: capture.control.observation.identity.captureRevision,
                        },
                    }),
                    'browser.get_page_info': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: {url},
                    }),
                    'browser.click': async (step: StepUnion) => ({
                        stepId: step.id,
                        ok: true,
                        data: {clickedId: (step.args as {nodeId?: unknown}).nodeId},
                    }),
                }) as any,
        } as any,
    }, {workspaceName, tabName, page});
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: url,
        capture: async () => capture,
    });
    return {deps, nodeIds};
};

const runWithCheckpoints = async (
    step: StepUnion,
    checkpoints: Checkpoint[],
) => {
    const fixture = await createDeps();
    const resolvedDeps = fixture.deps;
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
        resolvedDeps,
    );
    return {
        checkpoint,
        results: readResultPipe(pipe).items,
        nodeIds: fixture.nodeIds,
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
                            nodeId: { ref: 'local.actionTarget.nodeIds.0' },
                        },
                    },
                    saveAs: 'clickResult',
                } as unknown as CheckpointAction,
            ],
            output: {
                rowCount: { ref: 'local.rowCount.value' },
                clickedId: { ref: 'local.clickResult.clickedId' },
            },
        },
    ];

    const { checkpoint, results, nodeIds } = await runWithCheckpoints(step, checkpoints);
    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal((results[0].data as any).output.rowCount, 2);
    assert.equal((results[0].data as any).output.clickedId, nodeIds.next_page);
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

test('browser.checkpoint applies persisted V2 resolve sidecars to nested actions', async () => {
    const {deps, nodeIds} = await createDeps();
    let receivedResolve: StepUnion['resolve'];
    const baseExecutors = deps.pluginHost.getExecutors();
    deps.pluginHost.getExecutors = () => ({
        ...baseExecutors,
        'browser.click': async (nestedStep) => {
            receivedResolve = nestedStep.resolve;
            return {stepId: nestedStep.id, ok: true, data: {clicked: true}};
        },
    });
    const checkpoint: Checkpoint = {
        id: 'cp-resolve-sidecar',
        kind: 'procedure',
        content: [{
            type: 'act',
            step: {
                name: 'browser.click',
                args: {resolveId: 'approve-button'},
            },
        } as CheckpointAction],
    };
    const resolve = {hint: {target: {nodeId: nodeIds.next_page}}};
    const workspace = deps.resolveWorkspace('ws-1');
    deps.resolveWorkspace = () => ({
        ...workspace,
        workflow: {} as never,
        checkpoint: {
            getProvider: () => ({
                getCheckpoint: (id: string) => id === checkpoint.id ? checkpoint : null,
                getCheckpointResolves: (id: string) => id === checkpoint.id
                    ? {'approve-button': resolve}
                    : null,
            }),
        },
    } as never);

    const result = await executeBrowserCheckpoint({
        id: 'cp-call-resolve',
        name: 'browser.checkpoint',
        args: {checkpointId: checkpoint.id},
    }, deps, 'ws-1');

    assert.equal(result.ok, true);
    assert.deepEqual(receivedResolve, resolve);
});

test('browser.checkpoint validates nested entity_rules before invoking executors', async () => {
    const {deps} = await createDeps();
    let executorCalled = false;
    const baseExecutors = deps.pluginHost.getExecutors();
    deps.pluginHost.getExecutors = () => ({
        ...baseExecutors,
        'browser.click': async (nestedStep) => {
            executorCalled = true;
            return {stepId: nestedStep.id, ok: true};
        },
    });
    const checkpoint: Checkpoint = {
        id: 'cp-invalid-entity-rules',
        kind: 'procedure',
        content: [{
            type: 'act',
            step: {
                name: 'browser.click',
                args: {nodeId: 'node-1'},
                entityRules: {selection: 'explicit', profiles: []},
            },
        } as CheckpointAction],
    };
    const workspace = deps.resolveWorkspace('ws-1');
    deps.resolveWorkspace = () => ({
        ...workspace,
        workflow: {} as never,
        checkpoint: {
            getProvider: () => ({
                getCheckpoint: (id: string) => id === checkpoint.id ? checkpoint : null,
                getCheckpointResolves: () => ({}),
            }),
        },
    } as never);

    const result = await executeBrowserCheckpoint({
        id: 'cp-call-invalid-rules',
        name: 'browser.checkpoint',
        args: {checkpointId: checkpoint.id},
    }, deps, 'ws-1');

    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'ERR_BAD_ARGS');
    assert.equal(executorCalled, false);
});
