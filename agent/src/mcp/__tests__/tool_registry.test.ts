import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolSpecs, resolveEnabledToolNames } from '../tool_registry';

test('resolveEnabledToolNames excludes debug tools by default', () => {
    const enabled = resolveEnabledToolNames({});
    assert.equal(enabled.has('browser.read_console'), false);
    assert.equal(enabled.has('browser.read_network'), false);
    assert.equal(enabled.has('browser.take_screenshot'), false);
    assert.equal(enabled.has('browser.mouse'), false);
    assert.equal(enabled.has('browser.snapshot'), true);
});

test('resolveEnabledToolNames honors group and explicit enable/disable', () => {
    const enabled = resolveEnabledToolNames({
        RPA_MCP_TOOL_GROUPS: 'tab_navigation',
        RPA_MCP_ENABLE_TOOLS: 'browser.evaluate',
        RPA_MCP_DISABLE_TOOLS: 'browser.goto',
    });
    assert.equal(enabled.has('browser.list_tabs'), true);
    assert.equal(enabled.has('browser.get_content'), false);
    assert.equal(enabled.has('browser.goto'), false);
    assert.equal(enabled.has('browser.evaluate'), true);
});

test('getToolSpecs strips tabToken and prunes empty required', () => {
    const enabled = new Set(['browser.go_back']);
    const specs = getToolSpecs({ enabledTools: enabled });
    assert.equal(specs.length, 1);
    const schema = specs[0].inputSchema as { properties?: Record<string, unknown>; required?: unknown[] };
    assert.equal(Boolean(schema.properties?.tabToken), false);
    assert.equal(Array.isArray(schema.required), false);
});
