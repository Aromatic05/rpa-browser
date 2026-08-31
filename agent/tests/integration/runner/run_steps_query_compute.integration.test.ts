import test from 'node:test';
import assert from 'node:assert/strict';
import {
    closeStepsQueue,
    createResultPipe,
    createSignalChannel,
    createStepsQueue,
    readResultPipe,
    runSteps,
} from '../../../src/automation/runner/run_steps';
import {executeBrowserCompute} from '../../../src/automation/runner/steps/executors/compute';
import {executeBrowserQuery} from '../../../src/automation/runner/steps/executors/query';
import type {StepUnion} from '../../../src/automation/runner/steps/types';
import {completeRunStepsDeps} from '../../helpers/run_steps_workspace';
import {createV2BusinessPage} from '../../helpers/v2_business_page';

const createDeps = async () => {
    const page = {url: () => 'https://example.test/orders'};
    const deps = completeRunStepsDeps({
        config: {} as never,
        pluginHost: {
            getExecutors: () => ({
                'browser.query': executeBrowserQuery,
                'browser.compute': executeBrowserCompute,
            }) as never,
        } as never,
    }, {
        workspaceName: 'ws-1',
        tabName: 'tab-1',
        page,
    });
    const fixture = createV2BusinessPage({rowCount: 2});
    await deps.pageSession.ensureFresh({
        pageKey: page as never,
        pageUrl: page.url(),
        capture: async () => fixture.capture,
    });
    return deps;
};

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
    }, await createDeps());
    return {checkpoint, results: readResultPipe(pipe).items};
};

test('runSteps can consume V2 query rows in compute(len)', async () => {
    const {checkpoint, results} = await runWithSteps([
        {
            id: 'q_rows',
            name: 'browser.query',
            args: {
                from: 'snapshot',
                where: {role: 'tr', attrs: {'data-row-key': 'SO-001'}},
            },
        } as StepUnion,
        {
            id: 'c_len',
            name: 'browser.compute',
            args: {
                expr: {
                    op: 'len',
                    args: [{ref: {path: 'steps.q_rows.data.nodeIds'}}],
                },
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal((results[1].data as {value: number}).value, 1);
});

test('runSteps supports V2 query action and compute(exists)', async () => {
    const {checkpoint, results} = await runWithSteps([
        {
            id: 'q_submit',
            name: 'browser.query',
            args: {
                from: 'snapshot',
                where: {
                    role: 'button',
                    text: {contains: '提交'},
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
                    args: [{ref: {path: 'steps.q_submit.data.nodeIds'}}],
                },
            },
        } as StepUnion,
    ]);

    assert.equal(checkpoint.status, 'completed');
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, true);
    assert.equal((results[1].data as {value: boolean}).value, true);
});

test('runSteps returns stable failure for invalid compute op', async () => {
    const {checkpoint, results} = await runWithSteps([
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
