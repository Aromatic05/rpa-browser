import test from 'node:test';
import assert from 'node:assert/strict';
import type {AgentEvent} from '@earendil-works/pi-agent-core';
import {createAgentTraceCollector} from '../../../../src/agent/trace/collector';
import {mergeAgentTraceSnapshots} from '../../../../src/agent/trace/merge';
import {buildAgentRunReport} from '../../../../src/agent/report/builder';
import type {AgentRunResult} from '../../../../src/agent/execution/types';
import {createRedactionPolicy} from '../../../../src/security/redaction';

const SECRET = 's3cr3t-combo';

const start = (toolCallId: string, toolName: string, args: unknown): AgentEvent => ({
    type: 'tool_execution_start',
    toolCallId,
    toolName,
    args,
});

const end = (toolCallId: string, toolName: string): AgentEvent => ({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    isError: false,
    result: {content: [], details: {}},
});

test('browser.fill/type/select_option values never reach the AgentTraceSnapshot', async () => {
    const trace = createAgentTraceCollector({
        classifyToolCall: (name) => name === 'browser.fill' ? 'effect' : 'read',
    });
    await trace.handle(start('1', 'browser.fill', {selector: '#a', value: SECRET}));
    await trace.handle(end('1', 'browser.fill'));
    await trace.handle(start('2', 'browser.type', {selector: '#b', text: 'typed-secret'}));
    await trace.handle(end('2', 'browser.type'));
    await trace.handle(start('3', 'browser.select_option', {selector: '#c', values: ['opt-1', 'opt-2']}));
    await trace.handle(end('3', 'browser.select_option'));

    const snapshot = trace.snapshot();
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(SECRET), 'fill value must not survive, got: ' + serialized);
    assert.ok(!serialized.includes('typed-secret'), 'type text must not survive, got: ' + serialized);
    assert.ok(!serialized.includes('opt-1'), 'select_option values must not survive, got: ' + serialized);

    const tools = snapshot.tools;
    assert.equal((tools[0]?.args as Record<string, unknown>).value, '[redacted]');
    assert.equal((tools[1]?.args as Record<string, unknown>).text, '[redacted]');
    assert.equal((tools[2]?.args as Record<string, unknown>).values, '[redacted]');
    assert.equal((tools[0]?.args as Record<string, unknown>).selector, '#a');
});

test('benign fields, metrics, classification and world revisions survive redaction', async () => {
    let revision = 0;
    const trace = createAgentTraceCollector({
        classifyToolCall: (name) => name === 'browser.goto' ? 'effect' : 'read',
        readWorldRevision: () => ({pageEpoch: 'p1', captureRevision: revision++, freshness: 'fresh'}),
    });
    await trace.handle(start('1', 'browser.goto', {url: 'https://example.test/page', tokenHint: 'meta'}));
    await trace.handle(end('1', 'browser.goto'));
    await trace.handle(start('2', 'browser.fill', {selector: '#pw', value: SECRET}));
    await trace.handle(end('2', 'browser.fill'));

    const snapshot = trace.snapshot();
    assert.equal(snapshot.metrics.toolCalls, 2);
    assert.equal(snapshot.metrics.effectCalls, 1);
    assert.equal(snapshot.metrics.readCalls, 1);
    assert.equal(snapshot.tools[0]?.classification, 'effect');
    assert.equal(snapshot.tools[0]?.worldBefore?.captureRevision, 0);
    assert.equal(snapshot.tools[0]?.worldAfter?.captureRevision, 1);
    assert.equal((snapshot.tools[0]?.args as Record<string, unknown>).tokenHint, 'meta');

    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(SECRET));
});

test('registered exact secrets are masked under arbitrary key names', async () => {
    const policy = createRedactionPolicy({secrets: [SECRET]});
    const trace = createAgentTraceCollector({
        classifyToolCall: () => 'effect',
        redact: policy,
    });
    await trace.handle(start('1', 'browser.click', {selector: '#x', payload: `nested:${SECRET}`, other: 'keep'}));
    await trace.handle(end('1', 'browser.click'));

    const snapshot = trace.snapshot();
    const serialized = JSON.stringify(snapshot);
    assert.ok(!serialized.includes(SECRET), 'registered secret must not survive, got: ' + serialized);
    const args = snapshot.tools[0]?.args as Record<string, unknown>;
    assert.equal(args.payload, 'nested:[redacted]');
    assert.equal(args.other, 'keep');
});

test('redaction is deterministic and does not mutate the original tool args', async () => {
    const policy = createRedactionPolicy({secrets: [SECRET]});
    const make = () => {
        const trace = createAgentTraceCollector({
            classifyToolCall: () => 'effect',
            redact: policy,
        });
        const args = {selector: '#a', value: SECRET, opts: {label: 'keep'}};
        return {trace, args};
    };

    const first = make();
    const second = make();
    await first.trace.handle(start('1', 'browser.fill', first.args));
    await first.trace.handle(end('1', 'browser.fill'));
    await second.trace.handle(start('1', 'browser.fill', second.args));
    await second.trace.handle(end('1', 'browser.fill'));

    assert.deepEqual(first.trace.snapshot().tools.map((tool) => tool.args), second.trace.snapshot().tools.map((tool) => tool.args));
    assert.deepEqual(first.trace.snapshot().metrics, second.trace.snapshot().metrics);
    assert.equal(JSON.stringify(first.trace.snapshot().tools.map((tool) => tool.args)), JSON.stringify(second.trace.snapshot().tools.map((tool) => tool.args)));
    assert.equal(first.args.value, SECRET, 'original args must not be mutated');
    assert.equal(first.args.opts.label, 'keep');
});

test('merge defensively redacts tool args while preserving metrics', async () => {
    const trace = createAgentTraceCollector({
        classifyToolCall: () => 'effect',
        redact: createRedactionPolicy({secrets: ['zz-secret']}),
    });
    await trace.handle(start('1', 'browser.goto', {url: 'https://h.test/a', ref: 'zz-secret'}));
    await trace.handle(end('1', 'browser.goto'));

    const merged = mergeAgentTraceSnapshots([trace.snapshot()]);
    const serialized = JSON.stringify(merged);
    assert.ok(!serialized.includes('zz-secret'), 'merged args must be redacted, got: ' + serialized);
    assert.equal(merged.metrics.toolCalls, 1);
    assert.equal(merged.metrics.effectCalls, 1);
});

test('report builder remains compatible with redacted snapshots', async () => {
    const trace = createAgentTraceCollector({
        classifyToolCall: () => 'effect',
    });
    await trace.handle(start('1', 'browser.fill', {selector: '#pw', value: SECRET}));
    await trace.handle(end('1', 'browser.fill'));

    const result: AgentRunResult = {
        provider: 'test',
        model: 'test-model',
        text: 'done',
        trace: trace.snapshot(),
        executionMode: 'react-baseline',
    };
    const report = buildAgentRunReport(result);
    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes(SECRET), 'report must not leak the fill value, got: ' + serialized);
    assert.equal(report.schema, 'rpa.agent.run-report');
    assert.equal(report.toolMetrics.toolCalls, 1);
    assert.equal(report.toolMetrics.effectCalls, 1);
    assert.equal((report.toolCalls[0]?.args as Record<string, unknown>).value, '[redacted]');
    assert.equal(report.toolCalls[0]?.toolName, 'browser.fill');
});