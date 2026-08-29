import test from 'node:test';
import assert from 'node:assert/strict';
import {
    AGENT_BROWSER_TOOLS,
    classifyAgentToolCall,
    resolveAgentBrowserReadToolNames,
    resolveAgentBrowserToolNames,
} from '../../../../src/agent/tools/policy';

test('baseline agent surface excludes unrestricted evaluation and low-level mouse', () => {
    const tools = resolveAgentBrowserToolNames();
    assert.equal(tools.has('browser.evaluate'), false);
    assert.equal(tools.has('browser.mouse'), false);
    assert.equal(tools.has('browser.query'), true);
    assert.equal(tools.has('browser.snapshot'), true);
    assert.equal(tools.has('browser.click'), true);
});

test('baseline agent surface has an explicit classification for every tool', () => {
    const tools = resolveAgentBrowserToolNames();
    assert.deepEqual([...tools].sort(), AGENT_BROWSER_TOOLS.map((tool) => tool.name).sort());
    for (const tool of AGENT_BROWSER_TOOLS) {
        assert.ok(tool.classification === 'read' || tool.classification === 'effect' || tool.classification === 'dynamic');
    }
});

test('program planner browser surface is statically read-only', () => {
    const tools = resolveAgentBrowserReadToolNames();
    assert.equal(tools.has('browser.snapshot'), true);
    assert.equal(tools.has('browser.query'), true);
    assert.equal(tools.has('browser.click'), false);
    assert.equal(tools.has('browser.fill'), false);
    assert.equal(tools.has('browser.goto'), false);
    assert.equal(tools.has('browser.entity'), false);
    for (const name of tools) {
        assert.equal(AGENT_BROWSER_TOOLS.find((tool) => tool.name === name)?.classification, 'read');
    }
});

test('browser.entity classification depends on the requested operation', () => {
    for (const op of ['list', 'get', 'find']) {
        assert.equal(classifyAgentToolCall('browser.entity', {op}), 'read');
    }
    for (const op of ['add', 'delete', 'rename']) {
        assert.equal(classifyAgentToolCall('browser.entity', {op}), 'effect');
    }
});

test('navigation and interaction calls are effects while observations are reads', () => {
    assert.equal(classifyAgentToolCall('browser.query', {}), 'read');
    assert.equal(classifyAgentToolCall('browser.snapshot', {}), 'read');
    assert.equal(classifyAgentToolCall('browser.read_network', {}), 'read');
    assert.equal(classifyAgentToolCall('browser.goto', {url: 'https://example.com'}), 'effect');
    assert.equal(classifyAgentToolCall('browser.fill', {value: 'x'}), 'effect');
    assert.equal(classifyAgentToolCall('browser.click', {}), 'effect');
});

test('unknown or malformed dynamic calls fail closed as effects', () => {
    assert.equal(classifyAgentToolCall('browser.entity', {}), 'effect');
    assert.equal(classifyAgentToolCall('browser.not_real', {}), 'effect');
});
