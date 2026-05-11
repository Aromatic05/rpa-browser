import test from 'node:test';
import assert from 'node:assert/strict';
import { getToolSpecs, resolveEnabledToolNames } from '../../src/mcp/tool_registry';

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
        enabledToolGroups: ['tab_navigation'],
        enableTools: ['browser.evaluate'],
        disableTools: ['browser.goto'],
    });
    assert.equal(enabled.has('browser.list_tabs'), true);
    assert.equal(enabled.has('browser.get_content'), false);
    assert.equal(enabled.has('browser.goto'), false);
    assert.equal(enabled.has('browser.evaluate'), true);
});

test('getToolSpecs strips tabName and prunes empty required', () => {
    const enabled = new Set(['browser.go_back']);
    const specs = getToolSpecs({ enabledTools: enabled });
    assert.equal(specs.length, 1);
    const schema = specs[0].inputSchema as { properties?: Record<string, unknown>; required?: unknown[] };
    assert.equal(Boolean(schema.properties?.tabName), false);
    assert.equal(Array.isArray(schema.required), false);
});
