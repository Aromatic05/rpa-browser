import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { traceCall } from '../../../../src/automation/runner/trace/trace_call';
import { MemorySink, FileSink } from '../../../../src/automation/runner/trace/sink';
import { redactTraceEvent } from '../../../../src/automation/runner/trace/redact';
import type { TraceContext, TraceEvent, TraceHooks, ToolError } from '../../../../src/automation/runner/trace/types';
import { createNoopHooks } from '../../../../src/automation/runner/trace/hooks';
import { createRedactionPolicy } from '../../../../src/security/redaction';

const SECRET = 'c0rrect-h0rse-batt3ry';

const ctx = (sinks: TraceContext['sinks'], redact?: TraceContext['redact']): TraceContext => ({
    sinks,
    hooks: createNoopHooks(),
    cache: {},
    redact,
});

const asEvent = (event: TraceEvent) => event;

test('locator fill/type/selectOption values never reach a MemorySink', async () => {
    const sink = new MemorySink();
    const result = await traceCall(ctx([sink]), { op: 'trace.locator.fill', args: { selector: '#pw', value: SECRET } }, async () => undefined);
    assert.equal(result.ok, true);

    const events = sink.getEvents();
    assert.equal(events.length, 2);
    const serialized = JSON.stringify(events);
    assert.ok(!serialized.includes(SECRET), 'fill value must not be stored, got: ' + serialized);

    const startArgs = asEvent(events[0]!).args as Record<string, unknown>;
    assert.equal(startArgs.value, '[redacted]');
    assert.equal(startArgs.selector, '#pw');
    const endArgs = asEvent(events[1]!).args as Record<string, unknown>;
    assert.equal(endArgs.value, '[redacted]');
});

test('selectOption values and type text are masked at the sink boundary', async () => {
    const sink = new MemorySink();
    await traceCall(ctx([sink]), { op: 'trace.locator.selectOption', args: { selector: '#s', values: ['v1', 'v2'] } }, async () => ({ selected: ['v1'] }));
    await traceCall(ctx([sink]), { op: 'trace.locator.type', args: { selector: '#t', text: 'secret-text' } }, async () => undefined);

    const serialized = JSON.stringify(sink.getEvents());
    assert.ok(!serialized.includes('v1'), 'selectOption values must be masked, got: ' + serialized);
    assert.ok(!serialized.includes('v2'), 'selectOption values must be masked, got: ' + serialized);
    assert.ok(!serialized.includes('secret-text'), 'type text must be masked, got: ' + serialized);
    assert.ok(serialized.includes('"selector":"#s"'), 'benign selector must survive');
    assert.ok(serialized.includes('"selector":"#t"'), 'benign selector must survive');
});

test('registered exact secrets never survive in args, results or serialized errors', async () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const sink = new MemorySink();

    const data = {
        rows: [{ id: 1, note: `prefix ${SECRET}` }],
        url: `https://host.test/api?acc=keep&api_key=${SECRET}`,
    };
    const okResult = await traceCall(ctx([sink], policy), { op: 'trace.page.readNetwork', args: { filter: { user: SECRET } } }, async () => data);
    assert.ok(okResult.ok);

    const failResult = await traceCall(ctx([sink], policy), { op: 'trace.page.goto', args: { url: 'https://host.test/page' } }, async () => {
        throw new Error(`login failed for ${SECRET}`);
    });
    assert.equal(failResult.ok, false);

    const serialized = JSON.stringify(sink.getEvents());
    assert.ok(!serialized.includes(SECRET), 'registered secret must not be stored, got: ' + serialized);

    const errorEvent = sink.getEvents().find((event) => event.type === 'op.end' && !event.ok);
    assert.ok(errorEvent, 'a failed op.end event must be emitted');
    assert.ok(errorEvent.type === 'op.end' && !errorEvent.ok, 'expected a failed op.end event');
    assert.equal(errorEvent.error?.message, 'login failed for [redacted]');
    assert.equal(errorEvent.error?.code, 'ERR_UNKNOWN');
    assert.equal(errorEvent.error?.phase, 'trace');
    assert.equal(okResult.data, data, 'caller data must not be mutated');
});

test('tool error details are redacted recursively while code/phase are preserved', async () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const sink = new MemorySink(policy);
    const raw: TraceEvent = {
        type: 'op.end',
        ts: 1,
        op: 'trace.locator.click',
        ok: false,
        durationMs: 2,
        args: {},
        error: {
            code: 'ERR_NOT_FOUND',
            message: `missing ${SECRET}`,
            phase: 'trace',
            details: { selector: '#x', params: { q: SECRET, keep: 'k' } },
        },
    };

    sink.write(raw);
    const stored = sink.getEvents()[0];
    assert.ok(stored, 'an op.end event must be written');
    assert.ok(stored.type === 'op.end', 'expected an op.end event');
    assert.equal(stored.error?.code, 'ERR_NOT_FOUND');
    assert.equal(stored.error?.phase, 'trace');
    assert.equal(stored.error?.message, 'missing [redacted]');
    const serialized = JSON.stringify(stored);
    assert.ok(!serialized.includes(SECRET), 'details must not leak, got: ' + serialized);
    assert.ok(serialized.includes('"keep":"k"'));
});

test('onError hooks receive the redacted error, never the raw mapped error', async () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const sink = new MemorySink();
    let hookError: ToolError | undefined;
    const hooks: TraceHooks = {
        beforeOp: async () => {},
        afterOp: async () => {},
        onError: async (_event, error) => { hookError = error; },
    };

    const result = await traceCall(
        { sinks: [sink], hooks, cache: {}, redact: policy },
        { op: 'trace.page.goto', args: { url: 'https://host.test/page' } },
        async () => { throw new Error(`login failed for ${SECRET}`); },
    );
    assert.equal(result.ok, false);

    assert.ok(hookError, 'onError must be invoked with the tool error');
    assert.equal(hookError.message, 'login failed for [redacted]');
    assert.equal(hookError.code, 'ERR_UNKNOWN');
    assert.equal(hookError.phase, 'trace');
    assert.ok(!JSON.stringify(hookError).includes(SECRET), 'onError error must not leak the secret, got: ' + JSON.stringify(hookError));
});

test('redaction is deterministic for identical trace events', () => {
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const raw: TraceEvent = {
        type: 'op.end',
        ts: 1,
        op: 'trace.locator.fill',
        ok: true,
        durationMs: 1,
        args: { selector: '#a', value: SECRET },
        result: { list: [SECRET, { label: 'keep' }] },
    };

    const first = redactTraceEvent(raw, policy);
    const second = redactTraceEvent(raw, policy);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test('FileSink persists redacted events only', async () => {
    const filePath = path.join(os.tmpdir(), `agent-trace-redact-${process.pid}-${Date.now()}.jsonl`);
    const policy = createRedactionPolicy({ secrets: [SECRET] });
    const sink = new FileSink(filePath, policy);
    try {
        await traceCall(ctx([sink], policy), { op: 'trace.locator.fill', args: { selector: '#pw', value: SECRET } }, async () => ({ done: true }));
        await sink.close();

        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        assert.equal(lines.length, 2);
        const serialized = lines.join('\n');
        assert.ok(!serialized.includes(SECRET), 'file must not contain the secret, got: ' + serialized);
        assert.ok(serialized.includes('"selector":"#pw"'));
        assert.ok(serialized.includes('[redacted]'));
    } finally {
        await sink.close().catch(() => undefined);
        fs.rmSync(filePath, { force: true });
    }
});