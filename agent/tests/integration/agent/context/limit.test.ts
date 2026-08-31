import test from 'node:test';
import assert from 'node:assert/strict';
import {
    DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS,
    DEFAULT_TOOL_RESULT_SIZES,
    serializeAgentToolError,
    serializeAgentToolResult,
} from '../../../../src/agent/tools/context/limit';

const snapshotNode = (id: string, children: unknown[] = []): Record<string, unknown> => ({
    nodeId: id,
    scopeId: 'main',
    tag: 'button',
    role: 'button',
    name: `label-${id}`,
    text: 'synthetic text that inflates the serialized payload '.repeat(4),
    children,
});

const largeSnapshot = (): Record<string, unknown> => {
    const children = [];
    for (let index = 0; index < 5000; index += 1) {
        children.push(snapshotNode(`node-${index}`));
    }
    return {
        ok: true,
        results: [{stepId: 'step-snapshot-1', ok: true, data: snapshotNode('root', children)}],
    };
};

test('huge snapshot result stays valid JSON and is bounded by its per-tool budget', () => {
    const output = serializeAgentToolResult('browser.snapshot', largeSnapshot());
    assert.equal(output.truncated, true);
    assert.ok(output.originalChars > output.visibleChars);
    assert.ok(output.visibleBytes > 0);
    const cap = DEFAULT_TOOL_RESULT_SIZES['browser.snapshot']?.maxVisibleChars ?? Infinity;
    assert.ok(output.visibleChars <= cap);
    const parsed = JSON.parse(output.text) as {
        truncated: boolean;
        originalChars: number;
        originalBytes: number;
        visibleChars: number;
        visibleBytes: number;
        content: {results: Array<{stepId: string; data: {nodeId: string}}>};
    };
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.originalChars, output.originalChars);
    assert.equal(parsed.originalBytes, output.originalBytes);
    assert.equal(parsed.visibleChars, output.visibleChars);
    assert.equal(parsed.visibleBytes, output.visibleBytes);
    assert.equal(parsed.content.results[0]?.stepId, 'step-snapshot-1');
    assert.equal(parsed.content.results[0]?.data.nodeId, 'root');
});

test('identifiers needed for follow-up resolution are preserved under truncation', () => {
    const output = serializeAgentToolResult('browser.snapshot', largeSnapshot());
    const parsed = JSON.parse(output.text) as {
        content: {results: Array<{data: {children: Array<{nodeId: string}>}}>};
    };
    const children = parsed.content.results[0]?.data.children ?? [];
    assert.ok(children.length > 0);
    assert.equal(children[0]?.nodeId, 'node-0');
    assert.equal(children[1]?.nodeId, 'node-1');
    for (const child of children) {
        assert.match(child.nodeId, /^node-\d+$/);
    }
});

test('nested error payloads cannot bypass the result budget', () => {
    const nestedError = {
        ok: false,
        results: [{stepId: 'step-err', ok: false, data: 'huge '.repeat(50_000)}],
        error: {code: 'ERR_BIG', message: 'huge '.repeat(50_000)},
    };
    const output = serializeAgentToolResult('browser.query', nestedError);
    assert.equal(output.truncated, true);
    const cap = DEFAULT_TOOL_RESULT_SIZES['browser.query']?.maxVisibleChars ?? Infinity;
    assert.ok(output.visibleChars <= cap);
    const parsed = JSON.parse(output.text) as {truncated: boolean; content: {ok: boolean}};
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.content.ok, false);
});

test('ordinary small results are emitted byte-identical without an envelope', () => {
    const small = {ok: true, results: [{stepId: 's1', ok: true, data: {value: 1}}]};
    const output = serializeAgentToolResult('browser.query', small);
    assert.equal(output.truncated, false);
    assert.equal(output.text, JSON.stringify(small));
    assert.equal(output.originalChars, output.visibleChars);
    assert.equal(output.originalBytes, output.visibleBytes);
});

test('non-keep huge fields are truncated while keep-fields stay valid', () => {
    const payload = {
        ok: true,
        results: [{stepId: 'keep-me', ok: true, data: {content: 'x'.repeat(200_000)}}],
    };
    const output = serializeAgentToolResult('browser.get_content', payload);
    const cap = DEFAULT_TOOL_RESULT_SIZES['browser.get_content']?.maxVisibleChars ?? Infinity;
    assert.ok(output.visibleChars <= cap);
    const parsed = JSON.parse(output.text) as {content: {results: Array<{stepId: string}>}};
    assert.equal(parsed.content.results[0]?.stepId, 'keep-me');
});

test('adversarial JSON never produces an invalid fragment', () => {
    const cases: unknown[] = [
        {ok: true, results: [{stepId: 's1', ok: true, data: {emoji: '😀'.repeat(10_000), text: 'plain'.repeat(10_000)}}]},
        {ok: true, results: ['a'.repeat(50_000), 'b'.repeat(50_000)]},
        {ok: true, results: [{stepId: 'nested', ok: true, data: {deep: {deeper: {deepest: 'y'.repeat(30_000)}}}}]},
        {ok: true, results: [{stepId: 'quote', ok: true, data: {text: '"escaped\\"json"'.repeat(5_000)}}]},
        {ok: true, results: [{stepId: 'huge', ok: true, data: {text: 'z'.repeat(500_000)}}]},
    ];
    for (const value of cases) {
        const output = serializeAgentToolResult('browser.snapshot', value);
        const cap = DEFAULT_TOOL_RESULT_SIZES['browser.snapshot']?.maxVisibleChars ?? Infinity;
        assert.ok(output.visibleChars <= cap, 'visible output exceeds cap');
        assert.doesNotThrow(() => JSON.parse(output.text), 'output is not valid JSON');
        const parsed = JSON.parse(output.text) as {truncated?: boolean};
        if (output.truncated) {
            assert.equal(parsed.truncated, true);
        }
    }
});

test('error content is capped by the dedicated error budget even when the per-tool cap is larger', () => {
    const payload = {
        tool: 'browser.snapshot',
        error: {code: 'ERR_BIG', message: 'x'.repeat(200_000)},
        results: [{stepId: 's1', ok: false, error: 'y'.repeat(200_000)}],
    };
    const text = serializeAgentToolError('browser.snapshot', payload);
    const normalCap = DEFAULT_TOOL_RESULT_SIZES['browser.snapshot']?.maxVisibleChars ?? Infinity;
    assert.ok(normalCap > DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS);
    assert.ok(text.length <= DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS);
    const parsed = JSON.parse(text) as {truncated: boolean; content: {error: {code: string}}};
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.content.error.code, 'ERR_BIG');
});

test('an explicit error budget overrides the default error cap', () => {
    const payload = {
        tool: 'browser.query',
        error: {code: 'ERR_BIG', message: 'x'.repeat(30_000)},
        results: [],
    };
    const text = serializeAgentToolError('browser.query', payload, {
        'browser.query': {errorMaxVisibleChars: 20_000},
    });
    assert.ok(text.length <= 20_000);
    assert.ok(text.length > DEFAULT_TOOL_RESULT_ERROR_MAX_VISIBLE_CHARS);
});

test('synthetic large page fixture: model-visible context shrinks while details stay complete', () => {
    const children = [];
    for (let index = 0; index < 8000; index += 1) {
        children.push({
            nodeId: `node-${index}`,
            scopeId: 'main',
            tag: 'button',
            role: 'button',
            name: `label-${index}`,
            text: 'synthetic visible text for a large product page '.repeat(3),
            children: [],
        });
    }
    const fixture = {
        ok: true,
        results: [{
            stepId: 'step-page-1',
            ok: true,
            data: {nodeId: 'root', scopeId: 'main', tag: 'main', role: 'main', name: 'page', children},
        }],
    };

    const before = JSON.stringify(fixture).length;
    const output = serializeAgentToolResult('browser.snapshot', fixture);
    const after = output.visibleChars;

    assert.equal(output.truncated, true);
    assert.equal(output.originalChars, before);
    assert.ok(after < before, 'model-visible context did not shrink');
    assert.ok(after <= (DEFAULT_TOOL_RESULT_SIZES['browser.snapshot']?.maxVisibleChars ?? Infinity));
    assert.ok(after < before / 10, `reduction too small: ${after} chars visible of ${before} original`);
    assert.equal(before, JSON.stringify(fixture).length);

    const parsed = JSON.parse(output.text) as {
        truncated: boolean;
        originalChars: number;
        visibleChars: number;
        content: {results: Array<{stepId: string; data: {nodeId: string; children: Array<{nodeId: string}>}}>};
    };
    assert.equal(parsed.originalChars, before);
    assert.equal(parsed.visibleChars, after);
    assert.equal(parsed.content.results[0]?.stepId, 'step-page-1');
    assert.equal(parsed.content.results[0]?.data.nodeId, 'root');
    assert.equal(parsed.content.results[0]?.data.children[0]?.nodeId, 'node-0');
    assert.ok(parsed.content.results[0]?.data.children.length > 100);
});