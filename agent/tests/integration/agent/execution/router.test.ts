import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentExecutionRouter} from '../../../../src/agent/execution/router';
import type {AgentRunner} from '../../../../src/agent/execution/types';

const emptyTrace = () => ({
    metrics: {
        turns: 0,
        toolCalls: 0,
        readCalls: 0,
        controlCalls: 0,
        effectCalls: 0,
        failedToolCalls: 0,
        postErrorEffectCalls: 0,
    },
    tools: [],
});

const stubRunner = (text: string, calls: string[]): AgentRunner => ({
    run: async (request) => {
        calls.push(request.prompt);
        return {provider: request.provider, model: request.model, text, trace: emptyTrace()};
    },
});

test('execution router defaults to program and keeps baseline explicit', async () => {
    const programCalls: string[] = [];
    const baselineCalls: string[] = [];
    const runner = createAgentExecutionRouter({
        program: stubRunner('program', programCalls),
        baseline: stubRunner('baseline', baselineCalls),
    });

    const product = await runner.run({prompt: 'product', provider: 'p', model: 'm'});
    const baseline = await runner.run({
        prompt: 'baseline',
        provider: 'p',
        model: 'm',
        executionMode: 'react-baseline',
    });

    assert.equal(product.text, 'program');
    assert.equal(product.executionMode, 'program');
    assert.deepEqual(programCalls, ['product']);
    assert.equal(baseline.text, 'baseline');
    assert.equal(baseline.executionMode, 'react-baseline');
    assert.deepEqual(baselineCalls, ['baseline']);
});
