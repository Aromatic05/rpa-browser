import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceCall } from '../../src/runner/trace/trace_call';
import { MemorySink } from '../../src/runner/trace/sink';
import type { TraceContext } from '../../src/runner/trace/types';
import { createNoopHooks } from '../../src/runner/trace/hooks';

test('traceCall success writes start/end and returns ok', async () => {
    const sink = new MemorySink();
    let afterOpCalled = 0;
    const ctx: TraceContext = {
        sinks: [sink],
        hooks: {
            ...createNoopHooks(),
            afterOp: async () => {
                afterOpCalled += 1;
            },
        },
        cache: {},
    };

    const result = await traceCall(ctx, { op: 'trace.page.getInfo' }, async () => ({
        url: 'https://example.com',
        title: 'Example',
    }));

    assert.equal(result.ok, true);
    const events = sink.getEvents();
    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'op.start');
    assert.equal(events[1].type, 'op.end');
    assert.equal(events[1].ok, true);
    assert.equal(afterOpCalled, 1);
});

test('traceCall timeout maps to ERR_TIMEOUT', async () => {
    const sink = new MemorySink();
    let afterOpCalled = 0;
    const ctx: TraceContext = {
        sinks: [sink],
        hooks: {
            ...createNoopHooks(),
            afterOp: async () => {
                afterOpCalled += 1;
            },
        },
        cache: {},
    };

    const result = await traceCall(ctx, { op: 'trace.page.goto' }, async () => {
        const err = new Error('Timeout 1000ms');
        err.name = 'TimeoutError';
        throw err;
    });

    assert.equal(result.ok, false);
    if (!result.ok) {
        assert.equal(result.error.code, 'ERR_TIMEOUT');
    }
    assert.equal(afterOpCalled, 1);
});
