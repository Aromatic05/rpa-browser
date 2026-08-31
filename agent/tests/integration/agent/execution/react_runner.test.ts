import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall, Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentRunner} from '../../../../src/agent/execution/react_runner';

const listTabsTool: AgentTool = {
    name: 'browser.list_tabs',
    label: 'browser.list_tabs',
    description: 'List tabs.',
    parameters: Type.Object({}),
    execute: async () => ({content: [{type: 'text', text: '1'}], details: {ok: true}}),
};

test('react runner composes model, tools and trace without depending on MCP runtime', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('browser.list_tabs', {})),
        fauxAssistantMessage('There is one tab.'),
    ]);
    const runner = createReactAgentRunner({
        tools: [listTabsTool],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    const result = await runner.run({
        prompt: 'How many tabs are open?',
        provider: 'faux',
        model: 'baseline',
    });

    assert.equal(result.text, 'There is one tab.');
    assert.equal(result.trace.metrics.toolCalls, 1);
    assert.equal(result.trace.metrics.readCalls, 1);
    assert.equal(result.trace.metrics.effectCalls, 0);
});

test('react runner rejects unknown model', async () => {
    const runner = createReactAgentRunner({
        tools: [],
        modelRuntime: {resolve: () => null},
    });
    await assert.rejects(
        () => runner.run({prompt: 'x', provider: 'x', model: 'y'}),
        /model not found: x\/y/,
    );
});

test('react runner rejects model request failures instead of returning an empty success', async () => {
    const faux = createFauxCore({provider: 'faux', models: [{id: 'baseline'}]});
    faux.setResponses([
        fauxAssistantMessage([], {
            stopReason: 'error',
            errorMessage: 'fetch failed: connect ECONNREFUSED',
        }),
    ]);
    const runner = createReactAgentRunner({
        tools: [],
        modelRuntime: {
            resolve: (provider, model) => provider === 'faux' && model === 'baseline'
                ? {model: faux.getModel(), streamFn: faux.streamSimple}
                : null,
        },
    });

    await assert.rejects(
        () => runner.run({prompt: 'x', provider: 'faux', model: 'baseline'}),
        (error: unknown) => {
            const failure = error as {code?: string; message?: string};
            assert.equal(failure.code, 'ERR_AGENT_MODEL_REQUEST_FAILED');
            assert.match(failure.message ?? '', /ECONNREFUSED/);
            return true;
        },
    );
});
