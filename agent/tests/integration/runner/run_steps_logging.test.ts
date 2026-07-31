import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStepSink, runStepList } from '../../../src/runner/run_steps';
import type { StepUnion } from '../../../src/runner/steps/types';
import { completeRunStepsDeps } from '../../helpers/run_steps_workspace';

test('step start events redact user-entered values and nested credentials', async () => {
    const sink = new MemoryStepSink();
    const deps = completeRunStepsDeps({
        stepSinks: [sink],
        pluginHost: {
            getExecutors: () => ({
                'browser.fill': async (step: StepUnion) => ({stepId: step.id, ok: true}),
                'browser.checkpoint': async (step: StepUnion) => ({stepId: step.id, ok: true}),
            }) as any,
        } as any,
    }, {workspaceName: 'ws-log'});

    await runStepList('ws-log', [
        {id: 'fill-1', name: 'browser.fill', args: {selector: '#password', value: 'correct horse battery staple'}},
        {id: 'checkpoint-1', name: 'browser.checkpoint', args: {
            checkpointId: 'login',
            input: {username: 'alice', password: 's3cr3t', nested: {accessToken: 'token-value'}},
        }},
    ] as StepUnion[], deps, {checkpoints: []});

    const starts = sink.events.filter((event) => event.type === 'step.start');
    assert.deepEqual(starts[0]?.argsSummary, {selector: '#password', value: '[REDACTED]'});
    assert.deepEqual(starts[1]?.argsSummary, {
        checkpointId: 'login',
        input: {username: 'alice', password: '[REDACTED]', nested: {accessToken: '[REDACTED]'}},
    });
});

test('step start events redact business primary-key values and sensitive URL parameters', async () => {
    const sink = new MemoryStepSink();
    const deps = completeRunStepsDeps({
        stepSinks: [sink],
        pluginHost: {
            getExecutors: () => ({
                'browser.query': async (step: StepUnion) => ({stepId: step.id, ok: true, data: {kind: 'nodeId', nodeId: 'row'}}),
                'browser.goto': async (step: StepUnion) => ({stepId: step.id, ok: true}),
            }) as any,
        } as any,
    }, {workspaceName: 'ws-log'});

    await runStepList('ws-log', [
        {id: 'query-1', name: 'browser.query', args: {
            op: 'entity.target', businessTag: 'order.list',
            target: {kind: 'table.row', primaryKey: {fieldKey: 'orderNo', value: 'SO-42'}},
        }},
        {id: 'goto-1', name: 'browser.goto', args: {url: 'https://example.test/callback?token=secret&view=orders'}},
    ] as StepUnion[], deps, {checkpoints: []});

    const starts = sink.events.filter((event) => event.type === 'step.start');
    assert.equal((starts[0]?.argsSummary as any).target.primaryKey.value, '[REDACTED]');
    assert.match(String((starts[1]?.argsSummary as any).url), /token=%5BREDACTED%5D/);
    assert.match(String((starts[1]?.argsSummary as any).url), /view=orders/);
});
