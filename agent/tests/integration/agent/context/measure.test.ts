import test from 'node:test';
import assert from 'node:assert/strict';
import type {Usage} from '@earendil-works/pi-ai';
import type {AgentMessage} from '@earendil-works/pi-agent-core';
import {
    measureProviderVisibleContext,
    measureTextSize,
    projectProviderVisibleContext,
    serializeProviderVisibleContext,
} from '../../../../src/agent/tools/context/measure';

const user = (text: string): AgentMessage => ({role: 'user', content: [{type: 'text', text}], timestamp: 1});
const assistant = (text: string): AgentMessage => ({
    role: 'assistant',
    content: [{type: 'text', text}],
    api: 'openai-completions',
    provider: 'faux',
    model: 'baseline',
    usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
    stopReason: 'stop',
    timestamp: 1,
});

const toolResult = (text: string, details: unknown, usage: Usage | undefined): AgentMessage => ({
    role: 'toolResult',
    toolCallId: 'c1',
    toolName: 'browser.snapshot',
    content: [{type: 'text', text}],
    details,
    usage,
    isError: false,
    timestamp: 1,
});

const noTools: never[] = [];

const HUGE_USAGE: Usage = {
    input: 10_000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 10_100,
    cost: {input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2},
};

test('exact serialized chars and bytes are deterministic for identical context', () => {
    const messages = [user('hello'), assistant('hi'), toolResult('observed', {}, undefined)];
    const first = measureProviderVisibleContext('sys', messages, noTools);
    const second = measureProviderVisibleContext('sys', messages, noTools);
    assert.deepEqual(first, second);
    assert.ok(first.chars > 0);
    assert.ok(first.bytes > 0);
});

test('internal tool result details and usage never affect the model-visible size', () => {
    const small = measureProviderVisibleContext('sys', [toolResult('observed', {ok: true}, undefined)], noTools);
    const huge = measureProviderVisibleContext('sys', [
        toolResult('observed', {ok: true, huge: 'x'.repeat(500_000)}, HUGE_USAGE),
    ], noTools);
    assert.deepEqual(huge, small);
});

test('tool call ids and names are part of the provider-visible assistant payload', () => {
    const assistantCall: AgentMessage = {
        role: 'assistant',
        content: [{type: 'toolCall', id: 'call-1', name: 'browser.query', arguments: {q: 'x'}}],
        api: 'openai-completions',
        provider: 'faux',
        model: 'baseline',
        usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}},
        stopReason: 'stop',
        timestamp: 999_999,
    };
    const visible = serializeProviderVisibleContext('sys', [assistantCall], noTools);
    assert.ok(visible.includes('call-1'));
    assert.ok(visible.includes('browser.query'));
    assert.equal(visible.includes('999999'), false, 'timestamp must not leak into the projection');
});

test('active tool schemas are part of the provider-visible context and increase size', () => {
    const small = measureProviderVisibleContext('sys', [user('task')], [{
        name: 'browser.query',
        description: 'Query.',
        parameters: {type: 'object', properties: {}},
    }]);
    const bigSchema = measureProviderVisibleContext('sys', [user('task')], [{
        name: 'browser.snapshot',
        description: 'Inspect.',
        parameters: {type: 'object', properties: {huge: {type: 'string', description: 'x'.repeat(20_000)}}},
    }]);
    assert.ok(bigSchema.chars > small.chars);
    const projected = projectProviderVisibleContext('sys', [user('task')], [{
        name: 'browser.query',
        description: 'Query.',
        parameters: {type: 'object', properties: {}},
    }]);
    assert.deepEqual(projected.tools, [{
        name: 'browser.query',
        description: 'Query.',
        parameters: {type: 'object', properties: {}},
    }]);
});

test('model-visible projection excludes non-model custom messages', () => {
    const custom = {role: 'steering', content: [{type: 'text', text: 'hidden'}]};
    const visible = serializeProviderVisibleContext('sys', [user('a'), custom as AgentMessage], noTools);
    assert.equal(visible.includes('hidden'), false);
});

test('utf-8 bytes are authoritative and non-ascii inflates bytes above chars', () => {
    const text = 'huge 快照内容 😀';
    const size = measureTextSize(text);
    assert.equal(size.chars, text.length);
    assert.equal(size.bytes, Buffer.byteLength(text, 'utf8'));
    assert.ok(size.bytes >= size.chars);
});

test('accumulated tool result content increases the measured provider-visible context', () => {
    const before = measureProviderVisibleContext('sys', [user('task'), assistant('call')], noTools);
    const after = measureProviderVisibleContext('sys', [
        user('task'),
        assistant('call'),
        toolResult('x'.repeat(1000), {}, undefined),
    ], noTools);
    assert.ok(after.chars > before.chars);
    assert.ok(after.bytes > before.bytes);
});