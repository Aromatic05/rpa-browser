import test from 'node:test';
import assert from 'node:assert/strict';
import {createAgentTraceCollector} from '../../../../src/agent/trace/collector';
import {mergeAgentTraceSnapshots} from '../../../../src/agent/trace/merge';
import {createAgentContextAccountant} from '../../../../src/agent/tools/context/budget';

const collectorWithAccountant = (maxChars: number) => {
    const accountant = createAgentContextAccountant({maxChars});
    const trace = createAgentTraceCollector({
        classifyToolCall: (name) => name === 'read' ? 'read' : 'effect',
        context: () => accountant.account(),
    });
    return {accountant, trace};
};

test('trace context metrics reflect exact per-turn model-visible sizes', async () => {
    const {accountant, trace} = collectorWithAccountant(1_000_000);
    await trace.handle({type: 'turn_end', message: {} as never, toolResults: []});
    accountant.recordTurn('sys', [{role: 'user', content: [{type: 'text', text: 'hello'}], timestamp: 1}], []);

    const snapshot = trace.snapshot();
    const context = snapshot.context;
    assert.ok(context);
    assert.equal(context.turns.length, 1);
    assert.equal(context.turns[0]?.turn, 1);
    assert.ok((context.turns[0]?.chars ?? 0) > 0);
    assert.ok((context.turns[0]?.bytes ?? 0) > 0);
    assert.equal(context.peakChars, context.turns[0]?.chars);
    assert.equal(context.lastChars, context.turns[0]?.chars);
});

test('per-turn growth accumulates deterministically across turns', async () => {
    const {accountant, trace} = collectorWithAccountant(1_000_000);
    for (let index = 0; index < 3; index += 1) {
        await trace.handle({type: 'turn_end', message: {} as never, toolResults: []});
        accountant.recordTurn('sys', [
            {role: 'user', content: [{type: 'text', text: 'task'}], timestamp: 1},
            {role: 'toolResult', toolCallId: `c${index}`, toolName: 'read', content: [{type: 'text', text: 'x'.repeat(500 * (index + 1))}], details: {}, isError: false, timestamp: 1},
        ], []);
    }
    const context = trace.snapshot().context;
    assert.equal(context?.turns.length, 3);
    const chars = (context?.turns ?? []).map((turn) => turn.chars);
    assert.ok(chars[2] > chars[1]);
    assert.ok(chars[1] > chars[0]);
    assert.equal(context?.lastChars, chars[2]);
});

test('overflow is flagged in the per-turn record when the budget is exceeded', async () => {
    const {accountant, trace} = collectorWithAccountant(100);
    await trace.handle({type: 'turn_end', message: {} as never, toolResults: []});
    accountant.recordTurn('sys', [
        {role: 'user', content: [{type: 'text', text: 'task'}], timestamp: 1},
        {role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{type: 'text', text: 'y'.repeat(5000)}], details: {}, isError: false, timestamp: 1},
    ], []);
    const context = trace.snapshot().context;
    assert.equal(context?.turns[0]?.exceededBudget, true);
    const overflow = accountant.overflow();
    assert.ok(overflow);
    assert.equal(overflow?.limitChars, 100);
});

test('merge sums context turns and recomputes peak and last sizes', async () => {
    const {accountant: first, trace: firstTrace} = collectorWithAccountant(1_000_000);
    first.recordTurn('sys-a', [{role: 'user', content: [{type: 'text', text: 'aaa'.repeat(100)}], timestamp: 1}], []);
    firstTrace.handle({type: 'turn_end', message: {} as never, toolResults: []});

    const {accountant: second, trace: secondTrace} = collectorWithAccountant(1_000_000);
    second.recordTurn('sys-b', [{role: 'user', content: [{type: 'text', text: 'bbb'.repeat(200)}], timestamp: 1}], []);
    secondTrace.handle({type: 'turn_end', message: {} as never, toolResults: []});

    const merged = mergeAgentTraceSnapshots([firstTrace.snapshot(), secondTrace.snapshot()]);
    const context = merged.context;
    assert.ok(context);
    assert.equal(context.turns.length, 2);
    assert.ok(context.lastChars > (context.turns[0]?.chars ?? 0));
    assert.equal(context.peakChars, context.lastChars);
});

test('empty trace has no context metrics', async () => {
    const trace = createAgentTraceCollector({classifyToolCall: () => 'read'});
    const snapshot = trace.snapshot();
    assert.equal(snapshot.context, undefined);
});