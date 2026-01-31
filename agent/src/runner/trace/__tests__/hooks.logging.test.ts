import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLoggingHooks } from '../hooks';
import type { TraceEvent } from '../types';

const captureLogs = async (fn: () => Promise<void>) => {
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
    };
    try {
        await fn();
    } finally {
        console.log = original;
    }
    return logs;
};

test('logging hooks print success with args/result', async () => {
    const hooks = createLoggingHooks();
    const event: TraceEvent = {
        type: 'op.end',
        ts: Date.now(),
        op: 'trace.page.goto',
        ok: true,
        durationMs: 12,
        args: { url: 'https://example.com' },
        result: null,
    };
    const logs = await captureLogs(async () => {
        await hooks.afterOp?.(event);
    });
    assert.ok(logs.some((line) => line.includes('[trace]')));
    assert.ok(logs.some((line) => line.includes('op=trace.page.goto')));
    assert.ok(logs.some((line) => line.includes('ok=true')));
    assert.ok(logs.some((line) => line.includes('args=')));
    assert.ok(logs.some((line) => line.includes('result=')));
});

test('logging hooks print error with code', async () => {
    const hooks = createLoggingHooks();
    const event: TraceEvent = {
        type: 'op.end',
        ts: Date.now(),
        op: 'trace.locator.click',
        ok: false,
        durationMs: 25,
        args: { a11yNodeId: 'n0' },
        error: { code: 'ERR_NOT_FOUND', message: 'no match', phase: 'trace' },
    };
    const logs = await captureLogs(async () => {
        await hooks.afterOp?.(event);
    });
    assert.ok(logs.some((line) => line.includes('ok=false')));
    assert.ok(logs.some((line) => line.includes('ERR_NOT_FOUND')));
});

test('logging hooks truncate long base64 payload', async () => {
    const hooks = createLoggingHooks({ maxStringLength: 40, maxJsonLength: 200 });
    const longBase64 = 'a'.repeat(1000);
    const event: TraceEvent = {
        type: 'op.end',
        ts: Date.now(),
        op: 'trace.page.screenshot',
        ok: true,
        durationMs: 7,
        args: { fullPage: true },
        result: longBase64,
    };
    const logs = await captureLogs(async () => {
        await hooks.afterOp?.(event);
    });
    assert.ok(logs.some((line) => line.includes('result=')));
    assert.ok(logs.some((line) => line.includes('len') || line.includes('...')));
    assert.ok(!logs.some((line) => line.includes(longBase64)));
});
