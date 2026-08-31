import test from 'node:test';
import assert from 'node:assert/strict';
import {createFauxCore, fauxAssistantMessage, fauxToolCall, Type} from '@earendil-works/pi-ai';
import type {AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentSession} from '../../../../src/agent/loop/react';

const probeTool = (onCall: () => void): AgentTool => ({
    name: 'probe',
    label: 'probe',
    description: 'probe tool',
    parameters: Type.Object({}),
    execute: async () => {
        onCall();
        return {content: [{type: 'text', text: 'ok'}], details: {ok: true}};
    },
});

test('cooperative abort signal stops the run and discards a queued tool call', async () => {
    const faux = createFauxCore({provider: 'test', models: [{id: 'm'}]});
    const controller = new AbortController();
    let probeCalls = 0;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('probe', {})),
        fauxAssistantMessage(fauxToolCall('probe', {})),
    ]);
    const session = createReactAgentSession({
        model: faux.getModel(),
        streamFn: faux.streamSimple,
        tools: [probeTool(() => {
            probeCalls += 1;
            controller.abort();
        })],
        signal: controller.signal,
    });

    await session.agent.prompt('go');

    assert.equal(probeCalls, 1);
});

test('pre-aborted signal prevents any tool execution', async () => {
    const faux = createFauxCore({provider: 'test', models: [{id: 'm'}]});
    const controller = new AbortController();
    controller.abort();
    let probeCalls = 0;
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('probe', {})),
    ]);
    const session = createReactAgentSession({
        model: faux.getModel(),
        streamFn: faux.streamSimple,
        tools: [probeTool(() => {probeCalls += 1;})],
        signal: controller.signal,
    });

    await session.agent.prompt('go');

    assert.equal(probeCalls, 0);
});
