import test from 'node:test';
import assert from 'node:assert/strict';
import {
    createFauxCore,
    fauxAssistantMessage,
    fauxToolCall,
    Type,
} from '@earendil-works/pi-ai';
import type {AgentEvent, AgentTool} from '@earendil-works/pi-agent-core';
import {createReactAgentSession} from '../../../../src/agent/loop/react';

 test('react loop delegates tool execution to pi-agent-core sequentially', async () => {
    const faux = createFauxCore({provider: 'test', models: [{id: 'test-model'}]});
    faux.setResponses([
        fauxAssistantMessage(fauxToolCall('observe', {query: 'state'})),
        fauxAssistantMessage(fauxToolCall('mutate', {value: 'x'})),
        fauxAssistantMessage('done'),
    ]);
    const calls: string[] = [];
    const events: AgentEvent[] = [];
    const tools: AgentTool[] = [
        {
            name: 'observe',
            label: 'observe',
            description: 'read state',
            parameters: Type.Object({query: Type.String()}),
            execute: async () => {
                calls.push('observe');
                return {content: [{type: 'text', text: 'observed'}], details: {ok: true}};
            },
        },
        {
            name: 'mutate',
            label: 'mutate',
            description: 'change state',
            parameters: Type.Object({value: Type.String()}),
            execute: async () => {
                calls.push('mutate');
                return {content: [{type: 'text', text: 'changed'}], details: {ok: true}};
            },
        },
    ];
    const session = createReactAgentSession({
        model: faux.getModel(),
        streamFn: faux.streamSimple,
        tools,
        onEvent: (event) => {events.push(event);},
    });

    await session.agent.prompt('do it');

    assert.deepEqual(calls, ['observe', 'mutate']);
    assert.equal(events.filter((event) => event.type === 'turn_end').length, 3);
    assert.deepEqual(
        events.filter((event) => event.type === 'tool_execution_start').map((event) =>
            event.type === 'tool_execution_start' ? event.toolName : ''),
        ['observe', 'mutate'],
    );
});
