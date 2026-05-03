import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const projectRoot = path.resolve(process.cwd());

test('agent/src/mcp/server.ts does not exist', () => {
    assert.equal(fs.existsSync(path.join(projectRoot, 'src/mcp/server.ts')), false);
});

test('agent/src/mcp/index.ts does not export startMcpServer', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/index.ts'), 'utf8');
    assert.ok(!content.includes('startMcpServer'));
});

test('agent/src/mcp/index.ts does not export createMcpServer', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/index.ts'), 'utf8');
    assert.ok(!content.includes('createMcpServer'));
});

test('agent/src/mcp/index.ts does not export McpToolDeps (only WorkspaceMcpToolDeps)', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/index.ts'), 'utf8');
    assert.ok(!/(?<!Workspace)McpToolDeps/.test(content));
});

test('tool_handlers.ts does not define McpToolDeps', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!/export type McpToolDeps\b/.test(content));
});

test('tool_handlers.ts does not import PageRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!content.includes('PageRegistry'));
});

test('tool_handlers.ts does not import WorkspaceRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!/WorkspaceRegistry/.test(content));
});

test('tool_handlers.ts does not export createToolHandlers', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(!/export.*createToolHandlers\b/.test(content));
});

test('tool_handlers.ts exports createWorkspaceToolHandlers', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    assert.ok(/export.*createWorkspaceToolHandlers/.test(content));
});

test('no repo references to startMcpServer', () => {
    const result = execSync(
        'grep -rn "startMcpServer" --include="*.ts" --include="*.tsx" src/ || true',
        { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    assert.equal(result, '');
});

test('no repo references to createMcpServer export/import', () => {
    const result = execSync(
        'grep -rnE "export.*createMcpServer|import.*createMcpServer" --include="*.ts" --include="*.tsx" src/ || true',
        { cwd: projectRoot, encoding: 'utf8' },
    ).trim();
    assert.equal(result, '');
});

test('tool_registry.ts does not reference createToolHandlers', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_registry.ts'), 'utf8');
    assert.ok(!/createToolHandlers\b/.test(content));
});

test('tool_registry.ts does not import PageRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_registry.ts'), 'utf8');
    assert.ok(!content.includes('PageRegistry'));
});

test('tool_registry.ts does not import WorkspaceRegistry', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_registry.ts'), 'utf8');
    assert.ok(!/WorkspaceRegistry/.test(content));
});

test('mcp_main.ts starts MCP via workspace.mcp.handle', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp_main.ts'), 'utf8');
    assert.ok(content.includes("workspace.mcp.handle"));
});

test('mcp_main.ts does not reference startMcpServer', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp_main.ts'), 'utf8');
    assert.ok(!content.includes('startMcpServer'));
});

test('browser.* tool names are preserved in createWorkspaceToolHandlers map', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    const knownTools = [
        'browser.goto',
        'browser.go_back',
        'browser.reload',
        'browser.click',
        'browser.fill',
        'browser.snapshot',
        'browser.capture_resolve',
        'browser.entity',
        'browser.query',
        'browser.get_content',
        'browser.read_console',
        'browser.read_network',
        'browser.evaluate',
        'browser.take_screenshot',
        'browser.type',
        'browser.select_option',
        'browser.hover',
        'browser.scroll',
        'browser.press_key',
        'browser.drag_and_drop',
        'browser.mouse',
        'browser.create_tab',
        'browser.switch_tab',
        'browser.close_tab',
        'browser.get_page_info',
        'browser.list_tabs',
        'browser.batch',
    ];
    for (const name of knownTools) {
        assert.ok(
            content.includes(`'${name}'`),
            `createWorkspaceToolHandlers map missing tool key: ${name}`,
        );
    }
});

test('browser.* are not registered as action types', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/actions/action_types.ts'), 'utf8');
    assert.ok(!content.includes("'browser.goto'"));
    assert.ok(!content.includes("'browser.click'"));
    assert.ok(!content.includes("'browser.snapshot'"));
    assert.ok(!content.includes("'browser.fill'"));
});

test('all MCP tool name keys in createWorkspaceToolHandlers start with browser.', () => {
    const content = fs.readFileSync(path.join(projectRoot, 'src/mcp/tool_handlers.ts'), 'utf8');
    const exportBlock = content.slice(content.indexOf('export const createWorkspaceToolHandlers'));
    const toolEntries = exportBlock.match(/'([^']+)'/g) || [];
    const toolNames = toolEntries.map((e) => e.replace(/'/g, '')).filter((n) => n.startsWith('browser.'));
    assert.ok(toolNames.length > 20);
    for (const name of toolNames) {
        assert.ok(name.startsWith('browser.'), `MCP tool name must start with browser.: ${name}`);
    }
});
