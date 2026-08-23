import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentEvent} from '@earendil-works/pi-agent-core';
import {createAgentTraceCollector} from '../../../../src/agent/trace/collector';

const start = (toolCallId: string, toolName: string): AgentEvent => ({
    type: 'tool_execution_start', toolCallId, toolName, args: {},
});
const end = (toolCallId: string, toolName: string, isError: boolean): AgentEvent => ({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    isError,
    result: {content: [], details: {}},
});

test('trace distinguishes pure reads, effects and post-error effects', async () => {
    let revision = 0;
    const trace = createAgentTraceCollector({
        classifyToolCall: (name) => name === 'read' ? 'read' : 'effect',
        readWorldRevision: () => ({pageEpoch: 'p1', captureRevision: revision++, freshness: 'fresh'}),
    });
    await trace.handle(start('1', 'read'));
    await trace.handle(end('1', 'read', true));
    await trace.handle(start('2', 'effect'));
    await trace.handle(end('2', 'effect', false));

    const snapshot = trace.snapshot();
    assert.equal(snapshot.metrics.toolCalls, 2);
    assert.equal(snapshot.metrics.readCalls, 1);
    assert.equal(snapshot.metrics.effectCalls, 1);
    assert.equal(snapshot.metrics.failedToolCalls, 1);
    assert.equal(snapshot.metrics.postErrorEffectCalls, 1);
    assert.equal(snapshot.tools[0]?.worldBefore?.captureRevision, 0);
    assert.equal(snapshot.tools[0]?.worldAfter?.captureRevision, 1);
});
